# @qop/identity

Portable QOP identity protocol primitives.

The current package exports:

- The identity protocol version.
- Canonical codecs for MiniP2P PeerIds, 32-byte base64url values, ECDSA signatures, qids, chain IDs, Unix timestamps, and Ethereum addresses.
- Strict Effect schemas and encode/decode helpers for expiring `DeviceCertificateV1` certificates and `IdentityEnvelopeV1`.
- The fixed QOP EIP-712 domain and `DeviceCertificateV1` type definition.
- Effect helpers for certificate hashing, wallet-signature normalization, owner recovery, and owner verification.
- Strict schemas, EIP-712 definitions, digests, and signer recovery for registration, owner rotation, and device revocation intents, including the domain-separated initial PeerId/observation-capability commitment.
- Canonical, domain-separated device-session proof-of-possession challenges and Ed25519 signing/verification compatible with MiniP2P's raw 32-byte device keys and embedded PeerId public keys.

This package must not import React Native, Expo, HTTP server, or database modules.
