# @qop/identity

Portable QOP identity protocol primitives.

The current package exports:

- The identity protocol version.
- Canonical codecs for MiniP2P PeerIds, 32-byte base64url values, ECDSA signatures, qids, chain IDs, Unix timestamps, and Ethereum addresses.
- Strict Effect schemas and encode/decode helpers for expiring `DeviceCertificateV1` certificates and `IdentityEnvelopeV1`.
- The fixed QOP EIP-712 domain and `DeviceCertificateV1` type definition.
- Effect helpers for certificate hashing, wallet-signature normalization, owner recovery, and owner verification.
- Recovery-key helpers: `encodeRecoveryKeyV1`, `decodeRecoveryKeyV1`, and `ownerAddressFromRecoveryKeyV1`, with typed `RecoveryKeyError` failures.
- Strict schemas, EIP-712 definitions, digests, and signer recovery for registration, owner rotation, and device revocation intents, including the domain-separated initial PeerId/observation-capability commitment.
- Canonical, domain-separated device-session proof-of-possession challenges and Ed25519 signing/verification compatible with MiniP2P's raw 32-byte device keys and embedded PeerId public keys.

This package must not import React Native, Expo, HTTP server, or database modules.

## Recovery keys

A v1 recovery key has the canonical form `qop1_<43-character base64url payload>_<8-character lowercase hex checksum>`. The payload encodes exactly 32 bytes and must be a valid secp256k1 private scalar (`1 <= key < curve order`). The checksum is the first four bytes of the Keccak-256 digest of the domain `qop/recovery-key/v1` followed by the private key bytes.

- `encodeRecoveryKeyV1` validates owner key material and returns the canonical string.
- `decodeRecoveryKeyV1` validates the shape, canonical base64url encoding, owner key material, and checksum.
- `ownerAddressFromRecoveryKeyV1` returns the canonical lowercase Ethereum owner address.
- `RecoveryKeyError.operation` identifies `encode`, `decode`, or `derive-owner` failures.

These helpers return Effects so callers can handle failures before crossing a Promise boundary. A recovery key grants owner control and must be treated as a bearer secret: never log it or store it in ordinary application storage.
