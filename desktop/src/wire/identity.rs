//! Device keys and peer IDs (`@qop/identity` `device-key.ts`).
//!
//! A device key is the 32-byte Ed25519 public key; its peer ID is the
//! identity-multihash libp2p form minip2p uses, always 52 base58 chars.

use alloy_primitives::B256;
use minip2p::{Ed25519Keypair, PeerId};

/// Multihash prefix of an Ed25519 peer ID: identity hash, 36 bytes, then the
/// protobuf `PublicKey { type: Ed25519, data: 32 bytes }` header.
const ED25519_PEER_ID_PREFIX: [u8; 6] = [0, 36, 8, 1, 18, 32];
const ED25519_PEER_ID_CHARS: usize = 52;

/// The device key (public key) for a 32-byte Ed25519 secret key.
pub fn device_key_from_secret(secret_key: [u8; 32]) -> B256 {
    B256::from(Ed25519Keypair::from_secret_key_bytes(secret_key).public_key_bytes())
}

/// The minip2p peer ID a device key dials and listens as.
pub fn peer_id_from_device_key(device_key: &B256) -> PeerId {
    let multihash = [ED25519_PEER_ID_PREFIX.as_slice(), device_key.as_slice()].concat();

    PeerId::from_bytes(&multihash).expect("an Ed25519 identity multihash is a valid peer id")
}

/// The device key behind a canonical Ed25519 peer ID string, or `None` for
/// any other string (wrong length, other key types, non-base58).
pub fn device_key_from_peer_id(peer_id: &str) -> Option<B256> {
    if peer_id.len() != ED25519_PEER_ID_CHARS {
        return None;
    }

    let bytes = PeerId::from_base58(peer_id).ok()?.to_bytes();
    let device_key = bytes.strip_prefix(ED25519_PEER_ID_PREFIX.as_slice())?;

    (device_key.len() == 32).then(|| B256::from_slice(device_key))
}

/// The short code both screens show while pairing: the first 4 key bytes as
/// uppercase hex (`pairingFingerprint` in `pairing.ts`).
pub fn pairing_fingerprint(device_key: &B256) -> String {
    alloy_primitives::hex::encode_upper(&device_key[..4])
}
