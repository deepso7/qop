//! Local state in SQLite: who this device is and where linking stands. Non-secret only; the
//! device secret key lives in [`crate::keys`].
//!
//! One store per data directory, held exclusively: [`Store::open`] takes an advisory lock that
//! the kernel releases when the process exits, however it exits (the CLI's `lock.db`).
//! Schema changes append to [`MIGRATIONS`]; `PRAGMA user_version` records how many ran.

use std::fs::{self, File, OpenOptions};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use alloy_primitives::{Address, B256, U256};
use rusqlite::{Connection, OptionalExtension, params};

use crate::wire::{DeviceActionApproval, identity};

/// Applied in order; never edit a shipped entry, append a new one.
const MIGRATIONS: &[&str] = &[
    // v1: the device's identity, its pending approval, and the revoked marker.
    "CREATE TABLE identity (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        handle TEXT NOT NULL,
        qid TEXT NOT NULL,
        chain_id TEXT NOT NULL,
        registry TEXT NOT NULL,
        device_key TEXT NOT NULL,
        linked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE pending_approval (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        record BLOB NOT NULL
    );
    CREATE TABLE revoked (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        handle TEXT NOT NULL
    );",
];

/// `~/Library/Application Support/qop` on macOS (`$XDG_DATA_HOME/qop` elsewhere), or
/// `QOP_DATA_DIR` when set (tests and e2e runs use their own directories).
pub fn default_data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("QOP_DATA_DIR").filter(|dir| !dir.is_empty()) {
        return PathBuf::from(dir);
    }
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/qop")
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map_or_else(|| home.join(".local/share"), PathBuf::from)
            .join("qop")
    }
}

#[derive(Debug)]
pub enum StoreError {
    /// Another qop Desktop holds this data directory.
    Locked,
    Io(std::io::Error),
    Sql(rusqlite::Error),
    /// A row that this version cannot read.
    Corrupt(&'static str),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Locked => f.write_str("another qop Desktop is using this data directory"),
            Self::Io(error) => write!(f, "store: {error}"),
            Self::Sql(error) => write!(f, "store: {error}"),
            Self::Corrupt(what) => write!(f, "store: unreadable {what}"),
        }
    }
}

impl From<std::io::Error> for StoreError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sql(error)
    }
}

pub type StoreResult<T> = Result<T, StoreError>;

/// The account this device links to, and its own key. Written before any offer is shown.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    pub handle: String,
    pub qid: U256,
    pub chain_id: U256,
    pub registry: Address,
    pub device_key: B256,
    /// Set once this device's own chain read showed it as an active member.
    pub linked: bool,
}

impl Identity {
    pub fn peer_id(&self) -> String {
        identity::peer_id_from_device_key(&self.device_key).to_base58()
    }

    pub fn fingerprint(&self) -> String {
        identity::pairing_fingerprint(&self.device_key)
    }
}

pub struct Store {
    conn: Connection,
    dir: PathBuf,
    /// Held for the store's lifetime; the kernel drops the lock with the process.
    _lock: File,
}

impl Store {
    /// Opens (creating, 0700) `dir`, takes the single-instance lock, and migrates.
    pub fn open(dir: &Path) -> StoreResult<Store> {
        fs::create_dir_all(dir)?;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .mode(0o600)
            .open(dir.join("lock"))?;
        lock.try_lock().map_err(|error| match error {
            fs::TryLockError::WouldBlock => StoreError::Locked,
            fs::TryLockError::Error(error) => StoreError::Io(error),
        })?;
        let path = dir.join("qop.db");
        let conn = Connection::open(&path)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        let store = Store {
            conn,
            dir: dir.to_owned(),
            _lock: lock,
        };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> StoreResult<()> {
        let applied: i64 = self
            .conn
            .pragma_query_value(None, "user_version", |row| row.get(0))?;
        for (version, sql) in (1_i64..)
            .zip(MIGRATIONS)
            .skip(usize::try_from(applied).unwrap_or(0))
        {
            let tx = self.conn.unchecked_transaction()?;
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", version)?;
            tx.commit()?;
        }
        Ok(())
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn identity(&self) -> StoreResult<Option<Identity>> {
        let row = self
            .conn
            .query_row(
                "SELECT handle, qid, chain_id, registry, device_key, linked FROM identity",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, bool>(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((handle, qid, chain_id, registry, device_key, linked)) = row else {
            return Ok(None);
        };
        let corrupt = |_| StoreError::Corrupt("identity");
        Ok(Some(Identity {
            handle,
            qid: qid.parse().map_err(corrupt)?,
            chain_id: chain_id.parse().map_err(corrupt)?,
            registry: registry
                .parse()
                .map_err(|_| StoreError::Corrupt("identity"))?,
            device_key: device_key
                .parse()
                .map_err(|_| StoreError::Corrupt("identity"))?,
            linked,
        }))
    }

    /// Inserts or replaces the identity.
    pub fn save_identity(&self, identity: &Identity) -> StoreResult<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO identity (id, handle, qid, chain_id, registry, device_key, linked)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                identity.handle,
                identity.qid.to_string(),
                identity.chain_id.to_string(),
                identity.registry.to_string().to_lowercase(),
                identity.device_key.to_string(),
                identity.linked,
            ],
        )?;
        Ok(())
    }

    /// Forgets the identity and any pending approval (Unlink, revocation).
    pub fn delete_identity(&self) -> StoreResult<()> {
        self.conn
            .execute_batch("DELETE FROM pending_approval; DELETE FROM identity;")?;
        Ok(())
    }

    pub fn approval(&self) -> StoreResult<Option<DeviceActionApproval>> {
        let record: Option<Vec<u8>> = self
            .conn
            .query_row("SELECT record FROM pending_approval", [], |row| row.get(0))
            .optional()?;
        record
            .map(|bytes| {
                DeviceActionApproval::decode(&bytes)
                    .map_err(|_| StoreError::Corrupt("pending approval"))
            })
            .transpose()
    }

    /// Persists the approval the phone sent; `approvalSaved` goes out only after this returns.
    pub fn save_approval(&self, approval: &DeviceActionApproval) -> StoreResult<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO pending_approval (id, record) VALUES (1, ?1)",
            params![approval.encode()],
        )?;
        Ok(())
    }

    pub fn clear_approval(&self) -> StoreResult<()> {
        self.conn.execute("DELETE FROM pending_approval", [])?;
        Ok(())
    }

    /// The handle of an account that removed this device, until the user acknowledges it.
    pub fn revoked(&self) -> StoreResult<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT handle FROM revoked", [], |row| row.get(0))
            .optional()?)
    }

    /// Wipes the identity and records the revocation, atomically.
    pub fn revoke(&self, handle: &str) -> StoreResult<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute_batch("DELETE FROM pending_approval; DELETE FROM identity;")?;
        tx.execute(
            "INSERT OR REPLACE INTO revoked (id, handle) VALUES (1, ?1)",
            params![handle],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn clear_revoked(&self) -> StoreResult<()> {
        self.conn.execute("DELETE FROM revoked", [])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("qop-store-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn identity() -> Identity {
        Identity {
            handle: "alice".into(),
            qid: U256::from(42),
            chain_id: U256::from(31337),
            registry: "0x1111111111111111111111111111111111111111"
                .parse()
                .unwrap(),
            device_key: B256::repeat_byte(9),
            linked: false,
        }
    }

    #[test]
    fn persists_identity_across_reopen_and_holds_the_lock() {
        let dir = temp_dir("reopen");
        {
            let store = Store::open(&dir).expect("open");
            assert!(matches!(Store::open(&dir), Err(StoreError::Locked)));
            store.save_identity(&identity()).expect("save");
            assert_eq!(
                fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        let store = Store::open(&dir).expect("reopen after release");
        assert_eq!(store.identity().unwrap(), Some(identity()));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn revoking_wipes_the_identity_and_remembers_the_handle() {
        let dir = temp_dir("revoke");
        let store = Store::open(&dir).expect("open");
        store
            .save_identity(&Identity {
                linked: true,
                ..identity()
            })
            .unwrap();
        store.revoke("alice").unwrap();
        assert_eq!(store.identity().unwrap(), None);
        assert_eq!(store.revoked().unwrap().as_deref(), Some("alice"));
        store.clear_revoked().unwrap();
        assert_eq!(store.revoked().unwrap(), None);
        fs::remove_dir_all(dir).unwrap();
    }
}
