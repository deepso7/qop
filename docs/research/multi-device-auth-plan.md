# Multi-device authorization plan

Status: the on-chain model and requirements below are selected in the delivery plan. Protocol defaults listed under open decisions remain proposals. This document brings the auth plan into PR #9 so implementation does not depend on Cursor Project store files.

## Scope and selected model

Authorize multiple independent Ed25519 device keys under an account's existing owner. Each device has its own minip2p peer ID. Bob must recognize Alice's phone and CLI as the same `qid`, while removal disables only the removed device.

The first milestone is authorization, including revocation on existing connections. Prove that milestone before building the [durable message handoff](offline-message-delivery.md). The first delivery experiment uses Alice's phone and CLI with Bob on one device.

The pulled delivery plan selects these requirements:

- Owner-signed `addDevice` and `removeDevice` operations use EIP-712, nonces, and deadlines. The owner or recovery secret never goes to the CLI.
- Replace the single-device account and client model directly. No legacy primary-key compatibility path.
- Every active device key maps to its account through `qidByDeviceKey`.
- Revocation applies within a defined bound on existing connections, as well as new connections.
- Owner recovery after compromise removes all devices. They must be enrolled again.
- Removing a device preserves already accepted conversation history.
- Connecting another authorized device does not trigger an identity-key mismatch warning.

A small active-device cap, initially four, is proposed. The account model supports multiple mobile devices and a CLI; a desktop application is outside this slice.

## Why this model

Farcaster's Key Registry provides a precedent for an account's active and removed signing keys, enumeration, and owner-authorized removal. QOP can use that structure under its existing owner authority. Farcaster also documents removing signer messages from hubs; QOP explicitly retains accepted history instead. [Farcaster Key Registry](https://docs.farcaster.xyz/reference/contracts/reference/key-registry).

| Alternative | Reason to defer |
| --- | --- |
| Owner-signed versioned device list | Requires publication and freshness rules beyond the existing registry |
| Device certificates presented during connection | Requires certificate expiry or a separate revocation source; certificates alone do not enumerate reachable devices |
| One private device key copied to phone and CLI | Prevents independent revocation and exposes the same key on both machines |
| Rotating the sole key between devices | Replaces authorization instead of allowing concurrent devices |

Certificates remain a valid design with a specified revocation mechanism. They are unnecessary for the selected on-chain approach.

## Implementation sequence

### 1. Define registry behavior

Specify add/remove intents, replay protection, events, active-key enumeration, and global active-key uniqueness. Preserve the distinction between account ownership and messaging authority. Define how registration supplies the first device under the new model.

Settle the active-device cap, removal of the last device, relinking a removed key, and replacement at the cap. The recommended relinking policy is to generate a fresh key. If atomic replacement is needed, define it explicitly rather than assuming two separate transactions are atomic.

Specify ordinary owner rotation separately from recovery after compromise. The current contract preserves the device key on owner rotation; the selected recovery behavior must invalidate every prior device. The deployment plan must identify the new contract address and client configuration changes for the breaking transition.

### 2. Separate account and device reads

Provide active membership lookup by device key and active-device enumeration by `qid`. Bind membership and account details to a consistent block when verification requires multiple reads.

Verification answers whether a connected key belongs to Alice. Enumeration identifies authorized peer IDs that a sender can try. Neither proves that a device is currently reachable.

### 3. Bound live authorization

Replace connection-lifetime trust with time-bounded authorization. Record the verified account, device, chain state, and local verification age. Check validity before accepting messages, returning private sync data, or sending private data to the peer.

Recheck before the authorization age expires. Invalidate access on observed removal or a failed membership check. When a fresh read fails, access must stop once the allowed age expires. Chain event notifications may accelerate revocation but cannot be its sole mechanism.

Define the chain finality policy and maximum authorization age before implementation. State the bound relative to revocation becoming visible under that policy. Never refresh the age of cached authorization merely because an RPC request failed. Suspended clients must check age again on resume.

### 4. Update sessions and contacts

Authenticate the transport key's active membership and the expected `qid` or handle. Remove the equality check against a single account-derived peer ID.

Keep account contacts distinct from device records. A connection to Alice's CLI must not overwrite the account's identity with a new primary device. Roster notifications and identity warnings have different meanings. Record roster changes only when the client has evidence of them.

### 5. Add authenticated CLI enrollment

Generate the device key on the CLI. Bind the owner's approval to that exact key through an authenticated pairing exchange and demonstrate possession of the private key before exchanging account data. Submit the owner-signed intent through a transaction sender and wait for the selected chain acceptance policy before treating enrollment as complete.

The transaction sender, fee payment, pairing transport, and approval UI remain to be specified. Being able to relay a signed transaction does not itself provide a funded relayer.

## Open decisions before coding

- Exact maximum authorization age, chain finality policy, and RPC failure behavior.
- Whether ordinary owner rotation retains devices, and how recovery invalidation is represented.
- Active-device cap, zero-device accounts, removed-key reuse, and atomic replacement.
- Pairing protocol and transaction submission, including fees.
- Registry deployment and client cutover procedure.

## Acceptance checks

1. Bob accepts Alice's phone and CLI concurrently as the same account.
2. Removing either device stops its access on an existing connection within the specified bound. The other device continues working.
3. A stale contact cache cannot authorize a removed or unknown device. RPC failure cannot extend expired authorization.
4. Recovery removes all prior device access, including existing sessions. Previously accepted messages remain visible.
5. Invalid signatures, expired intents, replayed nonces, duplicate keys, and device-cap violations fail predictably.
6. A second authorized device causes no false identity-key mismatch warning.
7. The CLI receives no owner or recovery secret.

After these checks pass, implement pending-message handoff and receipt synchronization. Application-level encrypted envelopes, mailbox storage, and hosted full devices remain outside this auth milestone.

## Current code references

The implementation starts from [QOPIdentityRegistry.sol](../../contracts/src/QOPIdentityRegistry.sol), [registry-core.ts](../../mobile/src/lib/registry-core.ts), [p2p-sessions.ts](../../mobile/src/lib/p2p-sessions.ts), and [db.ts](../../mobile/src/lib/db.ts). These currently represent one device per account and cache successful authorization for a connection's lifetime.
