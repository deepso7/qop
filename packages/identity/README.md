# @qop/identity

Portable QOP identity protocol primitives.

The current package exports:

- The identity protocol version.
- Canonical codecs for MiniP2P PeerIds, 32-byte base64url values, ECDSA signatures, qids, chain IDs, Unix timestamps, and Ethereum addresses.
- Strict Effect schemas and encode/decode helpers for `DeviceCertificateV1` and `IdentityEnvelopeV1`.
- The fixed QOP EIP-712 domain and `DeviceCertificateV1` type definition.
- Effect helpers for certificate hashing, wallet-signature normalization, owner recovery, and owner verification.

This package must not import React Native, Expo, HTTP server, or database modules.
