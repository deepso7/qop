//! Where the device's Ed25519 secret key lives: a 0600 file next to the store (the CLI's
//! `device.key`, the default), or the macOS Keychain (`QOP_KEY_STORE=keychain`).
//!
//! The file is the default because the Keychain gets in the way of unsigned builds: cargo signs
//! each build ad hoc, the login keychain ties an item to the signature that created it, and a
//! rebuilt binary then blocks on a password prompt to read its own key (checked on macOS 27).
//! Revisit with code signing. Either way one key belongs to one data directory: the Keychain
//! account is the directory's path.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

const KEYCHAIN_SERVICE: &str = "sh.qop.desktop.device-key";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeyStore {
    Keychain { account: String },
    File { path: PathBuf },
}

#[derive(Debug)]
pub enum KeyError {
    Keychain(String),
    Io(std::io::Error),
    /// The stored value is not a 32-byte key, or the file is readable by others.
    Corrupt,
}

impl std::fmt::Display for KeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Keychain(detail) => write!(f, "keychain: {detail}"),
            Self::Io(error) => write!(f, "device key file: {error}"),
            Self::Corrupt => f.write_str("device key: not a private 32-byte key"),
        }
    }
}

/// Where the key is looked for, for errors: "the device key file …" or "the macOS Keychain …".
impl std::fmt::Display for KeyStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Keychain { account } => write!(f, "the macOS Keychain (account {account})"),
            Self::File { path } => write!(f, "the device key file {}", path.display()),
        }
    }
}

impl KeyStore {
    /// The store for `data_dir`: the file, unless `QOP_KEY_STORE=keychain`.
    pub fn for_data_dir(data_dir: &Path) -> KeyStore {
        match std::env::var("QOP_KEY_STORE").as_deref() {
            Ok("keychain") => KeyStore::Keychain {
                account: data_dir.display().to_string(),
            },
            _ => KeyStore::File {
                path: data_dir.join("device.key"),
            },
        }
    }

    pub fn load(&self) -> Result<Option<[u8; 32]>, KeyError> {
        let bytes = match self {
            Self::Keychain { account } => match entry(account)?.get_secret() {
                Ok(bytes) => bytes,
                Err(keyring::Error::NoEntry) => return Ok(None),
                Err(error) => return Err(KeyError::Keychain(error.to_string())),
            },
            Self::File { path } => match fs::metadata(path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(KeyError::Io(error)),
                Ok(meta) if meta.permissions().mode() & 0o077 != 0 => {
                    return Err(KeyError::Corrupt);
                }
                Ok(_) => fs::read(path).map_err(KeyError::Io)?,
            },
        };
        bytes.try_into().map(Some).map_err(|_| KeyError::Corrupt)
    }

    /// Stores `secret` durably (replacing any previous key) before returning.
    pub fn save(&self, secret: &[u8; 32]) -> Result<(), KeyError> {
        match self {
            Self::Keychain { account } => entry(account)?
                .set_secret(secret)
                .map_err(|error| KeyError::Keychain(error.to_string())),
            Self::File { path } => {
                let temporary = path.with_extension("tmp");
                let mut file = fs::OpenOptions::new()
                    .create(true)
                    .write(true)
                    .truncate(true)
                    .mode(0o600)
                    .open(&temporary)
                    .map_err(KeyError::Io)?;
                file.write_all(secret)
                    .and_then(|()| file.sync_all())
                    .map_err(KeyError::Io)?;
                fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
                    .map_err(KeyError::Io)?;
                fs::rename(&temporary, path).map_err(KeyError::Io)
            }
        }
    }

    pub fn delete(&self) -> Result<(), KeyError> {
        match self {
            Self::Keychain { account } => match entry(account)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(error) => Err(KeyError::Keychain(error.to_string())),
            },
            Self::File { path } => match fs::remove_file(path) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    Err(KeyError::Io(error))
                }
                _ => Ok(()),
            },
        }
    }
}

fn entry(account: &str) -> Result<keyring::Entry, KeyError> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account)
        .map_err(|error| KeyError::Keychain(error.to_string()))
}

/// 32 bytes from the OS entropy source: device secrets, offer secrets, session IDs.
pub fn random_32() -> [u8; 32] {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).expect("the OS entropy source works");
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_store_round_trips_privately_and_deletes() {
        let dir = std::env::temp_dir().join(format!("qop-keys-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let store = KeyStore::File {
            path: dir.join("device.key"),
        };

        assert_eq!(store.load().unwrap(), None);
        store.save(&[7; 32]).unwrap();
        assert_eq!(store.load().unwrap(), Some([7; 32]));
        assert_eq!(
            fs::metadata(dir.join("device.key"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );

        fs::set_permissions(dir.join("device.key"), fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(store.load(), Err(KeyError::Corrupt)));

        store.delete().unwrap();
        assert_eq!(store.load().unwrap(), None);
        fs::remove_dir_all(dir).unwrap();
    }
}
