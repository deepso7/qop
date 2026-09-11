# Multi-device authorization plan

Status: auth model, hard-cut, recovery wipe-all, and **live revocation on existing connections** are **LOCKED** (must-have for MVP). On resume: invalidate cached authorization (required design rule under live revoke). History preserve on remove is a **strong proposal** (treat as requirement unless overridden). Max auth age **value**, chain finality policy, RPC-failure behavior, API/contact tightenings, device-cap details, planned `rotateOwner` keep-devices, and auth-before-sync sequencing remain **proposal**. Protocol defaults under open decisions are recommended until locked. This document brings the auth plan into PR #9 so implementation does not depend on Cursor Project store files.

## Decision table

| Item | Status | Notes |
| --- | --- | --- |
| On-chain multi-device keys (`addDevice` / `removeDevice`) | **LOCKED** | Owner custody; `qidByDeviceKey` for every active key |
| Hard-cut / breaking OK | **LOCKED** | No legacy primary-key compatibility path |
| Owner recovery after compromise → wipe all devices | **LOCKED** | Devices must be re-added |
| Live revocation on existing connections | **LOCKED** | Must-have for MVP; not next-connect-only. On resume: invalidate cached auth + fresh registry verify. Age/finality/RPC values below stay proposal |
| History preserve on device remove | **Strong proposal** | Treat as requirement unless overridden |
| Max authorization age value | **Proposal** | Recommended: **60s monotonic elapsed time** (not wall-clock) |
| Chain finality policy | **Proposal** | Define before implementation |
| RPC-failure behavior after age | **Proposal** | Recommended: refuse sensitive ops (no silent extend) |
| Contact/`keyChanged` / device roster | **Proposal** | Second authorized device is not `keyChanged` |
| Device cap / zero-device / fresh key on relink | **Proposal** | Recommended: cap **4**; zero allowed; fresh key required |
| Planned `rotateOwner` keep-devices | **Proposal** | |
| Auth before outbox sync | **Proposal** | Recommended sequencing |

## Scope and selected model

Authorize multiple independent Ed25519 device keys under an account's existing owner. Each device has its own minip2p peer ID. Bob must recognize Alice's phone and CLI as the same `qid`, while removal disables only the removed device.

**Recommended sequencing (proposal — not locked):** prove authorization, including revocation on existing connections, before building the [durable message handoff](offline-message-delivery.md). Do not implement outbox sync against single-device auth. The first delivery experiment uses Alice's phone and CLI with Bob on one device.

Requirements:

- **LOCKED:** Owner-signed `addDevice` and `removeDevice` operations use EIP-712, nonces, and deadlines. The owner or recovery secret never goes to the CLI.
- **LOCKED:** Replace the single-device account and client model directly. No legacy primary-key compatibility path.
- **LOCKED:** Every active device key maps to its account through `qidByDeviceKey`.
- **LOCKED:** Revocation applies within a defined bound on **existing** connections, as well as new connections. “Next connect only” is rejected as the sole revoke story. (Exact age, finality, and RPC-failure defaults remain **proposal** below.)
- **LOCKED:** Owner recovery after compromise removes all devices. They must be enrolled again.
- **Strong proposal:** Removing a device preserves already accepted conversation history.
- **Proposal:** Connecting another authorized device does not trigger an identity-key mismatch warning (`keyChanged`).

**Not the multi-device path:** Do not present `rotateDevice` (single-key replace) or `rotateDevice` ping-pong as how a second device joins. Fold or defer it as optional convenience later; CLI MVP needs add+remove. Do not share one device key across phone and CLI.

A small active-device cap, initially four (**proposal**, recommended until locked), is proposed. The account model supports multiple mobile devices and a CLI; a desktop application is outside this slice.

## Why this model

Farcaster's Key Registry provides a precedent for an account's active and removed signing keys, enumeration, and owner-authorized removal. QOP can use that structure under its existing owner authority. Farcaster also documents removing signer messages from hubs; QOP explicitly retains accepted history instead. [Farcaster Key Registry](https://docs.farcaster.xyz/reference/contracts/reference/key-registry).

| Alternative | Reason to defer |
| --- | --- |
| Owner-signed versioned device list | Requires publication and freshness rules beyond the existing registry |
| Device certificates presented during connection | Requires certificate expiry or a separate revocation source; certificates alone do not enumerate reachable devices |
| One private device key copied to phone and CLI | Prevents independent revocation and exposes the same key on both machines |
| Rotating the sole key between devices (`rotateDevice` as multi-device) | Replaces authorization instead of allowing concurrent devices; not the multi-device path |

Certificates remain a valid design with a specified revocation mechanism. They are unnecessary for the selected on-chain approach.

## Implementation sequence

### 1. Define registry behavior

Specify add/remove intents, replay protection, events, active-key enumeration, and global active-key uniqueness. Preserve the distinction between account ownership and messaging authority. Define how registration supplies the first device under the new model.

Settle the active-device cap, removal of the last device, relinking a removed key, and replacement at the cap (**proposal** until locked). Recommended until locked: cap **4**; zero-device accounts allowed; relink requires a **fresh** key (removed key cannot return as the same bytes); at cap, `addDevice` reverts and replace is `removeDevice` then `addDevice`. If atomic replacement is needed, define it explicitly rather than assuming two separate transactions are atomic.

Specify ordinary owner rotation separately from recovery after compromise. Planned `rotateOwner` keep-devices remains **proposal**. The current contract preserves the device key on owner rotation; the **LOCKED** recovery behavior must invalidate every prior device. The deployment plan must identify the new contract address and client configuration changes for the breaking transition.

### 2. Separate account and device reads

Provide active membership lookup by device key (`lookupDeviceKey`) and active-device enumeration by `qid` via `listActiveDevices(qid)` (or equivalent). Bind membership and account details to a consistent block when verification requires multiple reads.

Verification answers whether a connected key belongs to Alice. Enumeration (`listActiveDevices`) identifies authorized peer IDs for dial, handoff, and UI roster. Neither proves that a device is currently reachable.

### 3. Bound live authorization (**LOCKED** requirement; age/finality/RPC values **proposal**)

Today `p2p-sessions` caches `session.contact` for the connection’s life and skips further `lookupDeviceKey` once set. That is insufficient for an always-on CLI: after `removeDevice`, Bob must stop accepting that peer on an **existing** P2P connection within a defined bound.

Replace connection-lifetime trust with time-bounded authorization. Record the verified account, device, chain state, and local verification age. Check validity before accepting messages, returning private sync data, or sending private data to the peer.

**Monotonic elapsed-time measurement (not wall-clock):** While the process is running, authorization age is measured as **monotonic elapsed time** since the last successful registry confirm for that `connId` (e.g. performance.now-style — not wall-clock `Date`). Wall-clock jumps must not extend authorization.

**Suspend / resume (required with live revoke):** On resume (app/process wake from sleep/suspend), **invalidate cached authorization** and require a fresh registry verification before any sensitive operation. Do **not** let authorization age “pause” across sleep such that an overnight revoke is missed (e.g. Bob verifies Alice’s CLI, sleeps, the key is removed, then resumes using yesterday’s authorization). A wake is never a free refresh of auth.

**Fresh confirmation:** Only a successful registry membership read that reflects current chain state for that verify/recheck resets the age. A successful response from a **stale or cached** RPC (or any reply that does not confirm current membership) must **not** count as fresh chain confirmation and must **not** reset the authorization age.

Recheck before the authorization age expires while running. Invalidate access on observed removal or a failed membership check. When a fresh read fails, access must stop once the allowed age expires. Chain event notifications may accelerate revocation but cannot be its sole mechanism.

Define the chain finality policy and maximum authorization age before implementation (**proposal** until locked). Recommended until locked: max authorization age **60s monotonic elapsed time** since last successful fresh registry confirm for that connection while running; on RPC error during recheck, keep prior auth only until that age, then **refuse** sensitive ops (no silent extend). State the bound relative to revocation becoming visible under that policy. Never refresh the age of cached authorization merely because an RPC request failed or returned stale/cached success.

### 4. Update sessions and contacts

Authenticate the transport key's active membership and the expected `qid` or handle. Remove the equality check against a single account-derived peer ID.

Keep account contacts distinct from device records. A connection to Alice's CLI must not overwrite the account's identity with a new primary device. Roster notifications and identity warnings have different meanings: authorizing a second concurrent device is **not** `keyChanged`. Record roster changes only when the client has evidence of them.

### 5. Add authenticated CLI enrollment

Generate the device key on the CLI. Bind the owner's approval to that exact key through an authenticated pairing exchange and demonstrate possession of the private key before exchanging account data. Submit the owner-signed intent through a transaction sender and wait for the selected chain acceptance policy before treating enrollment as complete.

The transaction sender, fee payment, pairing transport, and approval UI remain to be specified. Being able to relay a signed transaction does not itself provide a funded relayer.

## Open decisions before coding

- Exact maximum authorization age (**proposal**; recommended **60s monotonic elapsed time** while running), chain finality policy, and RPC failure behavior (**proposal**; recommended refuse after age — no silent extend). Live revoke itself is **LOCKED**. Resume → invalidate cached auth is a **required** design rule under that lock.
- Whether ordinary owner rotation retains devices (**proposal**), and how recovery invalidation is represented (**LOCKED** wipe-all on compromise recovery).
- Active-device cap, zero-device accounts, removed-key reuse, and atomic replacement (**proposal**; recommended defaults above until locked).
- Pairing protocol and transaction submission, including fees.
- Registry deployment and client cutover procedure.

## Acceptance checks

1. Bob accepts Alice's phone and CLI concurrently as the same account.
2. Removing either device stops its access on an existing connection within the specified bound. The other device continues working.
3. A stale contact cache cannot authorize a removed or unknown device. RPC failure cannot extend expired authorization. Stale/cached RPC success cannot reset authorization age.
4. Recovery removes all prior device access, including existing sessions. Previously accepted messages remain visible.
5. Invalid signatures, expired intents, replayed nonces, duplicate keys, and device-cap violations fail predictably.
6. A second authorized device causes no false identity-key mismatch warning (not `keyChanged`).
7. The CLI receives no owner or recovery secret.
8. Wall-clock changes do not extend live authorization; on resume, cached authorization is invalidated and fresh registry verification is required before sensitive ops; while running, the monotonic elapsed-time bound applies.

After these checks pass, implement pending-message handoff and receipt synchronization (**recommended sequencing — proposal**). Application-level encrypted envelopes, mailbox storage, and hosted full devices remain outside this auth milestone.

## Current code references

Implemented on this branch:

- [QOPIdentityRegistry.sol](../../contracts/src/QOPIdentityRegistry.sol) — enumerable active devices; `addDevice` / `removeDevice` / `wipeDevices`; `listActiveDevices`
- [registry-intents.ts](../../packages/identity/src/registry-intents.ts) — Add/Remove/Wipe EIP-712 intents
- [registry-core.ts](../../mobile/src/lib/registry-core.ts) — membership lookup + device list
- [p2p-sessions.ts](../../mobile/src/lib/p2p-sessions.ts) — multi-device verify; 60s monotonic auth age; resume invalidate
- [db.ts](../../mobile/src/lib/db.ts) — contact identity by `qid`; no false `keyChanged` on roster updates
