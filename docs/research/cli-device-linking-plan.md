# Link a CLI device

Status: implementation plan, September 12, 2026. Based on merge `9443fe0`.

The user selected phone approval with QR pairing and API sponsorship of device-action fees. The protocol defaults below are recommendations for implementation, not previously locked product decisions.

Revised after the [Grok 4.6 review](cli-device-linking-grok-review.md). This revision makes approval recovery, signer checks and relay reconciliation explicit, and replaces per-operation uncached verification with bounded authorization plus a required CLI lifecycle check. The review remains a record of the earlier draft; this revision has not been reviewed by Grok.

## Outcome

Alice runs `qop link --account alice`, scans the terminal QR from her phone, and approves the new device. Both devices independently confirm enrollment on chain. Bob accepts messages from either as Alice. Alice can remove the CLI from her phone, including while its connection to Bob remains open.

Completion requires a real phone/CLI demonstration and CLI restart with the same device identity. Durable outbox handoff and receipt reconciliation follow in a separate milestone. This milestone transfers no conversation history or pending messages.

## Existing foundation and gaps

| Area | Current state | Work in this milestone |
| --- | --- | --- |
| Registry | Add/remove, four active devices, zero allowed, removed keys cannot return, shared account nonce | Use existing contract; verify deployment matches it |
| Identity library | Add/remove schemas, typed data, hashes and signature recovery | Add signing functions and pairing codecs |
| Phone vault | Owner secret stays in secure storage; register/recover/wipe signing | Add narrowly scoped add/remove signing |
| Registry reader | Device enumeration and membership; account nonce decoded but not returned | Expose a consistent owner/nonce/device snapshot for actions |
| Sessions | Device membership, 60-second authorization age, resume invalidation | Share the authorization implementation with the CLI |
| API | Registration relay with persisted prepared transactions | Sponsor add/remove using the same relayer nonce coordination |
| Product | No CLI or device-management screen | CLI lifecycle, QR scan, approval, roster and removal |

The older [auth plan](multi-device-auth-plan.md) still describes several implemented contract rules as proposals. Use the [contract](../../contracts/src/QOPIdentityRegistry.sol) and its tests for existing behavior. This plan specifies the next work rather than reopening those rules.

## User flow

1. `qop link --account alice` resolves Alice using the CLI's configured chain and registry. It creates and durably saves a fresh device key before displaying a QR. If already linked, it shows the account and directs the user to `qop start`.
2. On the phone, Profile > Devices > Link device opens the scanner. Scanning connects to the CLI and verifies that the connected peer owns the exact QR device key.
3. The phone shows the account, a device label and a short key fingerprint. It explains that the device can send and receive as Alice. Labels are local display metadata, not proof of identity.
4. Alice taps Link device. The phone reads the current owner, account nonce and roster, then signs and persists the exact add-device intent. It sends the approval to the CLI and waits for its durable acknowledgment before submitting to the API.
5. Both screens show confirmation progress. The API returns transaction status; each device checks chain membership itself before displaying Linked. A submitted transaction alone is insufficient.
6. `qop start` loads the same device key and verifies its membership before enabling account messaging. `qop status` reports the configured account, peer ID and current verification state without exposing secrets.
7. Profile > Devices lists the current on-chain roster, marks This device, and lets Alice remove the CLI. The phone displays removal progress and preserves existing conversation history.

Use terminal QR output with a copyable pairing payload as a fallback. The phone can paste that payload when camera access is unavailable. Both inputs use the same validation and approval path. Limit the first supported CLI platforms to macOS and Linux; include Linux for later always-on deployment.

## Pairing protocol

Use a dedicated versioned minip2p stream, proposed `/qop/pair/1`. The phone initiates pairing; only the CLI in `qop link` accepts inbound pairing streams. Pre-enrollment access is limited to pairing; it must not bypass normal chat authorization. Verify outgoing stream requirements against the pinned transport release and configure the phone endpoint accordingly, without routing inbound pairing through its chat handler. `qop start` does not accept new pairing requests.

The QR contains a version, session ID, expiration, chain ID, registry address, expected qid, CLI device public key, a bounded list of complete peer addresses, and a random 32-byte pairing secret. Proposed lifetime is five minutes, with one active pairing session per CLI data directory. Do not embed owner secrets, RPC credentials or an API URL. Both clients use their own trusted configuration and reject mismatched chain, registry or account.

The phone derives the expected peer ID from the QR key and pins the transport connection to it. Over that authenticated connection, the phone presents the pairing secret and a fresh challenge. The CLI validates the active session and returns the challenge with the same session/account/key context. Successful communication on the key-pinned transport demonstrates possession of the device key; the QR secret binds the phone to this local pairing session. Compare the stream's actual peer identity, not a peer ID claimed in a payload.

The phone signs only after successful pairing and explicit approval. Before acknowledging a new approval, the CLI verifies its owner signature against a fresh account read and checks the exact key, qid, chain, registry, nonce and deadline. It also verifies the approving phone's active membership. Once submission may have occurred, recovery uses the saved digest and transaction evidence; an already-consumed nonce or expired deadline must not make a successfully executed approval impossible to recover. Enrollment succeeds only after independent on-chain confirmation.

Proposed limits: 1 KiB of encoded QR text, at most two addresses, 16 KiB protocol frames, one approval in flight, bounded connection timeouts. Test actual terminal rendering and phone scanning before fixing the encoding. If addresses exceed the QR budget, select a reachable address or use the bounded paste path; do not silently render an untested larger QR. Reject unknown versions, mismatched keys, reused sessions and expired sessions. Keep the pairing secret out of ordinary logs and persistent records; clear it on completion or cancellation.

The first successful handshake with the pairing secret and an active phone belonging to the expected account claims the session for that phone's transport key. Further peers cannot claim it. After a disconnect or restart, a fresh QR may resume the same pending enrollment, but cannot authorize a second intent while the first has an unknown outcome. A resumed approval must match the saved digest. Invalid attempts do not consume the session; bound their rate and let the CLI operator replace an unapproved session.

Before signing, Cancel ends pairing. Once an intent has been signed and shared, closing the scanner cannot revoke that signature, even before submission. At that point the UI offers Stop waiting and retains the operation for reconciliation. If it confirms and Alice changes her mind, removal is a separate signed action. Do not delete a pending key while its transaction outcome is unknown.

Use known direct or relay addresses initially. Pairing must report unreachable/expired and allow a new QR without silently enrolling another key. Automatic discovery is separate work.

## Approval persistence and recovery

The phone is the sole automatic submitter. Both devices poll operation status by digest through their independently configured trusted API URL and verify membership through their configured RPC. Pairing messages never choose either endpoint.

1. The phone builds an immutable approval record containing protocol version, operation, domain, intent, owner signature, digest and expected owner. The intent includes qid, device key, account nonce and deadline. Persist it atomically before sending it to the CLI or API, following the existing registration persist-before-submit pattern.
2. The phone sends `approval` with the session ID and record over the pinned pairing stream. After validation, the CLI atomically saves the record alongside its already-persisted key, then returns `approvalSaved` with the session ID and digest. Repeated identical records return the same acknowledgment; a different digest conflicts with a pending record.
3. Only after the acknowledgment does the phone submit the saved record. Persist API status and transaction hash when known on each device. A status notification over the pairing stream is optional acceleration; polling and chain reads are the recovery path.
4. After restart, both devices reconcile their saved digest before accepting another approval. If the API has no record, the phone may retry the identical submission once the CLI's durable acknowledgment is established. A lost acknowledgment requires re-pairing and re-sending the same record. Never infer failure from API unavailability or re-sign just to retry.
5. If the chain already shows the key active, verify its account and the matching action evidence before completing recovery. If the add succeeded but the key was subsequently removed, report Removed. Do not restore it from the historical approval.

Local states distinguish a saved approval, acknowledgment by the CLI, API submission, and a resolved outcome. Neither approval persistence nor API acceptance means Linked. Retain the digest and public transaction evidence for resolved operations; clear pairing secrets and unneeded signature material. Removal uses the same phone persist-before-submit flow but needs no cooperation or acknowledgment from the device being removed.

Proposed signing deadline is ten minutes from the freshly read chain timestamp. The API rejects new intents beyond that horizon; expiry of the five-minute QR only prevents new pairing, not reconciliation. Before permitting a replacement approval, establish that the old intent cannot execute under the configured chain policy. Expiry alone does not clear an already-submitted transaction's reserved relayer nonce.

## Approval-bound signing

Add/remove intents contain no owner field. Read qid, owner, nonce and roster at one block, and verify that the owner matches the identity held by the phone vault. Construct the EIP-712 domain from trusted application configuration. The QR's domain and account are comparison values, not signing configuration.

The approval screen and signing operation use the same immutable action record. For add, bind its device key to the peer key verified during pairing; for remove, bind it to the user-selected roster key. Inside the owner-signing flow, compare the intent against that approved record and the fresh account snapshot. Reject changes to operation, domain, qid, key, nonce or deadline; require renewed approval if those fields must change. Do not expose arbitrary caller-supplied add/remove intents as the product signing interface.

Keep the pure cryptographic signing functions in `@qop/identity`; account/configuration checks and approval ownership belong in the phone's signing flow around the vault. A second caller-supplied `expectedDeviceKey` is not by itself an approval boundary. Test the wiring from displayed approval through signing, including attempts to substitute a key or domain after approval. These checks prevent implementation mistakes; they do not claim to protect against a fully compromised phone process.

## Sponsored device actions

Add a device-action API group for typed add/remove submissions and status by intent digest. Accept only those two operations for the configured registry. The API pays gas; it receives no owner secret and has no authority to approve devices itself.

Before spending gas on a new operation, validate the schema, domain, current owner signature, account nonce, deadline and applicable roster rules against uncached chain state, then simulate the action. Use the intent digest as the idempotency key. Look up existing operations before applying current-nonce/deadline checks so a retry can retrieve its already-confirmed result. At most one `ready` or `submitted` device action may exist per configured chain/registry/qid, enforced transactionally in the store with a unique constraint. Return an explicit in-flight conflict for a different digest. External owner actions may still win the on-chain nonce race; obtain fresh user approval before signing a changed intent.

Registration and device actions must share durable allocation of the relayer wallet's transaction nonce, including across API processes. Reuse or extract the existing prepared-transaction persistence and broadcast machinery. Persist signed transaction bytes and their hash before broadcast; after a crash, reconcile or rebroadcast that same transaction instead of spending gas on a second one. Keep registration admission and device-action authorization separate.

Keep the current allocator's lock and atomic prepare/persist sequence for this milestone. Do not introduce a second nonce table or move preparation outside the lock without a complete reservation-recovery design. Bound RPC timeouts while holding the lock. Recovery must service all persisted submissions, including registrations, so an abandoned lower nonce cannot permanently block a removal. Keep dropped or underpriced transactions pending and visible; fee replacement requires an explicit same-nonce recovery policy and must not happen as an implicit new operation.

Expose ready, submitted, confirmed, reverted, expired and temporarily unavailable outcomes. Confirm a sponsored operation from its stored transaction's successful canonical receipt at the configured acceptance depth and its matching registry event, including operation, qid, key and account nonce. A moved account nonce or current membership alone does not prove that digest executed. A reverted receipt is terminal for that digest; retrying the product action requires new approval. A timeout or missing receipt is unresolved, not reverted.

Operation confirmation is historical; Linked/Removed is a separate current roster read. A same-block later removal can make a successfully confirmed add currently inactive. Do not demand end-of-block active membership as proof that the earlier add executed. If a receipt loses canonicality before the chosen acceptance boundary, reconcile the operation as pending again. Production reorg handling must follow the selected chain policy.

Use fresh block-pinned reads for action validation and membership reconciliation, not the registration reader's account cache. An intent that expired before execution must not be marked failed merely because a response arrived late; check transaction evidence first. Freeing an account's action slot is separate from consuming the relayer transaction nonce: continue tracking any signed/submitted transaction until that nonce is resolved.

Bound sponsorship with configurable per-account/IP request limits, a global spending limit, maximum gas/fee limits and a bounded queue. Reject invalid requests before allocating work. An add-action quota must not exhaust the capacity reserved for removals. API outage prevents sponsored changes while existing authorized messaging continues under the registry freshness rules. Update README claims that the API is used only once.

## Shared code and storage

Add `cli/` as a workspace package using Node.js 24 and `@minip2p/node`, pinning a version compatible with the app's installed minip2p version after an interoperability check. Current upstream docs describe a shared TypeScript interface for Node and React Native; verify the pinned release before relying on individual APIs. [minip2p runtimes](https://minip2p.com/typescript/start/), [Node setup](https://minip2p.com/typescript/setup-node/).

Create one small shared package, proposed `packages/protocol`, for pairing codecs and the platform-independent registry/session/chat pieces both runtimes actually need. Replace the sessions' dependency on mobile database types with the smallest structural contact-storage interface required by their current behavior. Keep Expo storage, Zustand, UI and native lifecycle adapters in `mobile/`; keep CLI filesystem and process adapters in `cli/`. Move the relevant tests with the implementation. Avoid two copies of authorization logic or a general messaging-framework rewrite.

CLI storage contains its device secret and public account/configuration metadata, never the phone's recovery key. Use a private data directory, atomic persistence before presenting a QR, restrictive permissions and a single-process lock. Refuse insecure existing permissions or conflicting processes with a clear recovery action. Keep the pending key and submitted operation metadata across crashes. A removed device must generate a new key when relinking.

The mobile vault remains responsible for owner signing. The CLI identity format must not reuse the phone's stored identity format, which requires a recovery key. Store device names locally, keyed by registry/qid/device key; unknown roster entries get a fingerprint fallback.

For QR scanning, add the SDK 57-compatible camera package and rebuild the development client. Request camera permission only when opening the scanner, configure QR-only scanning, disable unnecessary audio permission, and stop the camera when the screen loses focus. [Expo SDK 57 camera](https://docs.expo.dev/versions/v57.0.0/sdk/camera/).

## Chain acceptance and revocation

The current local configuration uses chain 31337. For the local acceptance demo, set API `REGISTRY_CONFIRMATIONS=0` and use the same mined-receipt policy on the clients, with a consistent membership read at or after the receipt block. Advance Anvil when an expired or invalidated authorization needs a newer head, not before every message. Record this as a development policy, not a production finality guarantee.

Production rollout requires the actual target chain and an explicit acceptance/finality policy. Apply that policy consistently to enrollment, removal and membership reads. Choose sponsorship quota and fee limits for that deployment, including removal capacity. Verify that the API, phone and CLI point to the same multi-device registry deployment.

Reuse the existing 60-second maximum authorization age and refusal of sensitive operations when fresh authorization is unavailable. State revocation latency relative to the removal becoming visible under the configured chain policy, not from the instant Alice taps Remove.

Share the existing positive authorization cache on the CLI. Consecutive operations within a valid 60-second authorization window may use the same confirmed head. Only a successful revalidation at a strictly newer head starts another window. Expired or invalidated authorization must not be extended by a same-head response. Keep the existing epoch checks so invalidation also rejects an in-flight verification result.

Before implementing the CLI messaging path, prove a lifecycle adapter on macOS and Linux that invalidates authorization before the first sensitive operation after suspend or a significant event-loop stall. It must also invalidate verification begun before the interruption. The design must specify a suspend-aware elapsed-time source or ordered platform wake notification, its integration with the shared epoch, and a check at the sensitive-operation boundary. Timer callbacks alone are insufficient evidence; wall-clock drift may conservatively trigger invalidation but cannot be the sole proof of freshness. Test the selected mechanism on both operating systems, including wall-clock changes and verification interrupted by sleep.

This lifecycle mechanism is an explicit implementation gate, not an already-proven property of Node or the shared sessions. If it cannot be demonstrated, keep CLI messaging disabled until it is resolved. Do not work around it with uncached same-head reads or weaken the mobile freshness rules. Transport and pairing work can proceed independently.

## Implementation order

1. Confirm Node/mobile transport interoperability with their pinned releases, including outbound pairing from the phone endpoint. Prove the CLI lifecycle adapter before enabling messaging. Encode the approval/recovery state machine above, move the minimum shared authorization code with existing tests, and add the CLI identity store.
2. Add add/remove signing, current action-state reads and sponsored submission/reconciliation. Test concurrent registration and device transactions against the shared relayer nonce allocator.
3. Connect the CLI pairing command to the phone scanner and approval screen. Implement expiry, rejection, cancellation and recovery after interrupted confirmation.
4. Add the phone roster and removal flow, CLI startup/status checks, and a minimal diagnostic chat path using the existing wire protocol to prove Bob recognizes both devices.
5. Run the real-device acceptance sequence, update setup/runbook documentation and mark the superseded auth-plan statuses against the final implementation.

These are ordered implementation steps for the linking milestone. Split into reviewable commits or PRs where useful, but do not call the milestone complete before removal and the real-device checks work.

## Acceptance checks

- Pair Alice's phone and CLI with distinct keys. Bob sees one Alice account and no false identity-change warning when either sends.
- Restart the CLI and verify the same key, peer ID and account. A removed key cannot restart as authorized or be reused for relinking.
- Reject a substituted key/address, wrong account/domain, expired QR, replayed session, oversized frame and unapproved request. No normal chat is accepted through the pairing protocol.
- Kill either side before signing, after submission and after chain confirmation but before the response. Recover the actual enrollment state without silently creating another key or another transaction.
- Also interrupt after phone persistence, after CLI persistence but before its acknowledgment, and after acknowledgment but before API submission. A resumed pairing must reuse the digest; removal must work with the CLI offline.
- Mutate the approved key, domain, operation or nonce before signing and verify rejection. Verify that a retry of a confirmed digest is not rejected merely because its nonce has been consumed.
- Submit duplicate intents, race add/remove against another account action, and submit a registration concurrently with a device action. Exercise an API crash after transaction preparation and after broadcast.
- Remove the CLI while its Bob connection stays open. Attempt traffic from the removed CLI independently of its cooperative shutdown. Bob rejects it within the configured authorization bound; Alice's phone still works and accepted history remains.
- Exercise RPC failure, stale reads and suspend with verification in flight. No private operation may extend expired authorization on those paths.
- Send two messages on one connection without mining another block; both succeed within the authorization window. After expiry or lifecycle invalidation, a same-head reply cannot renew it. Exercise real sleep/wake on both supported CLI operating systems.
- Confirm an add followed by remove in the same block. Report successful add history and current Removed state. Exercise receipt reorg before acceptance, reverted actions, expired approvals and lower-nonce relay recovery.
- Verify the four-device cap and readable removal-required UI. Preserve the contract's zero-device semantics without adding automatic replacement behavior.

Run package tests, typechecking and lint with the new packages included in the root checks. Run contract checks for any changed ABI/contract integration. The final phone/CLI/Bob sequence uses native development builds; mocks alone do not validate transport interoperability. For planning, source and docs were inspected; no runtime checks have been run.

## Following milestone

After linking passes, specify durable outbox records, conflict handling, handoff acknowledgments and completion retention. The next acceptance demo is phone handoff, phone close, CLI restart, Bob return, one displayed message, and receipt reconciliation when the phone reopens. See the [delivery plan](offline-message-delivery.md).
