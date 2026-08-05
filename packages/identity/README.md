# @qop/identity

Portable QOP identity protocol primitives.

The current package exports:

- The identity protocol version.
- Canonical codecs for MiniP2P PeerIds, 32-byte base64url values, ECDSA signatures, qids, and Unix timestamps.
- Strict Effect schemas and encode/decode helpers for `DeviceCertificateV1` and `IdentityEnvelopeV1`.

This package must not import React Native, Expo, HTTP server, or database modules.
