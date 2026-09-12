# Cursor CLI review of linked-device delivery

Requested September 11, 2026 through `cursor-agent --print --mode ask --model auto`. The CLI completed successfully. `auto` is the requested selection; the underlying model was not reported. The review inspected the revised plan and repository in read-only mode. The response below is preserved as returned, apart from Markdown formatting.

## Project lock update (2026-09-11)

The reviewer response below is historical. Locked Project decisions now override open “pick an auth model” language:

| Topic | Locked / recommended |
| --- | --- |
| MVP promise | Always-on CLI holds pending sends; phone-only unchanged |
| Auth model | On-chain multi-device keys (`addDevice` / `removeDevice`); **not** `rotateDevice` as the multi-device path |
| Breaking | Hard-cut OK; no soft migration / dual-read of single `deviceKey` |
| Revoke | **LOCKED:** must cover **live** connections (recheck, invalidate) — not next-connect-only. On resume: invalidate cached auth + fresh registry verify. Max age value / finality / RPC-failure still **proposal** (monotonic elapsed time while running; recommended 60s) |
| Contacts | Key by `qid` + device roster; do not misuse `keyChanged` for a second authorized device |
| Owner recovery after compromise | Wipe all devices / re-add |
| History on remove | Preserve already-accepted conversation history |
| Mailbox / E2EE / hosted | Non-goals / comparison only for this slice |
| Sequencing | Auth (with live revoke) **before** phone↔CLI outbox sync — **proposed/recommended**, not locked |

See the updated [main plan](offline-message-delivery.md) lead and device-authorization section.

## Changes incorporated and qualifications

The main plan now leads with the locked always-on CLI MVP promise while Bob remains single-device for the first durability demo. Auth is locked to on-chain multi-device keys; sync rules and mailbox material stay separated (mailbox = comparison only). Recipient device sync remains required before shipping the wider any-device delivery promise. Phone-only users' availability limits are explicit.

Three reviewer details need qualification:

- Deduplication must use the sender account and logical message ID across holders. Adding the delivering device to that identity would defeat deduplication when two Alice devices deliver the same message. Original-device attribution can be separate metadata.
- The current global UUID key does suppress identical IDs across holders. Its weakness is the lack of authenticated account scoping and content-conflict validation, not failure to suppress a repeated UUID.
- Reusing live transport is reasonable, but the existing chat protocol and authentication cannot be assumed sufficient unchanged. Bob must authorize the CLI as an Alice device via registry multi-key lookup (no primary-`peerId` equality), and logical-message and receipt semantics need a protocol decision. The review's phrase "no app E2EE" refers to the absence of independently encrypted message envelopes; current live transport is encrypted and authenticated.

The external response uses its own wording and severity labels. Its recommendations are not benchmark or security-audit results.

## Reviewer response

## Verdict

**Prototype the linked-device path.** Current-QOP claims in the doc match HEAD (`e0cc503`). The main proposal is the right _next_ candidate if QOP wants offline delivery without a third-party message store. It does **not** yet solve phone-only users; that still needs an always-on own device, hosted endpoint, or mailbox.

---

## Prioritized findings

### P0 — Multi-device authorization is the hard blocker

**Fact:** Registry stores one `deviceKey` and `rotateDevice` replaces it (`contracts/src/QOPIdentityRegistry.sol`). Chat auth is live-only: transport `peerId` → device key → registry handle (`mobile/src/lib/p2p-sessions.ts`). Contacts cache that single key.

**Gap:** Alice’s CLI cannot deliver as Alice until Bob can authorize a _second_ peer as her account. Presence/beacons authenticate a key, not account permission (doc already says this). Enrollment language is right; the wire/registry contract is not specified enough to build against.

**Plan change (now locked):** Use on-chain multi-device keys (`addDevice` / `removeDevice`), hard-cut from single `deviceKey`. Contacts learn via `qid` + active roster + live registry freshness (including mid-connection recheck). Do not start outbox sync before auth with live revoke. Do **not** treat `rotateDevice` as the multi-device path.

### P1 — “Saved on another own device” vs “Delivered” is correct; durable handoff still underspecified

**Fact:** Today save-before-send / save-before-ACK / ACK→`sent` exist (`p2p-store-core.ts`, `p2p-send.ts`); no auto outbox; no own-device sync; no desktop/CLI app.

**Gap:** Phone↔holder sync needs: crash-safe persist before handoff ACK, retention across CLI restart, and completion records that prevent a stale device from resurrecting a finished send. Doc states these; it does not define the sync schema or conflict rule.

**Plan change:** Prototype gate = phone handoff → kill phone → CLI restart → Bob returns → one logical message → phone learns receipt on reopen. Anything less is not this architecture. **Recommended:** complete auth milestone first.

### P1 — Dedup/receipts today are weaker than the proposal

**Fact:** Dedup is `INSERT OR IGNORE` on message `id` only (`mobile/src/lib/db.ts`). Wire UUID is sender-chosen (`chat-wire.ts`). Duplicate receive still ACKs (good for lost ACK). No offline receipt channel.

**Gap:** Multi-holder retries need authenticated `(sender account/device, logical id)` uniqueness and receipt sync among Alice’s devices. Current PK scope is insufficient once several holders send the same logical message.

### P1 — Recipient “any device” + later phone sync is a second multi-device product

**Fact:** Bob is also one registry device today.

**Opinion:** Shipping “delivered = any Bob device” without Bob-side catch-up will look like message loss on his phone. Doc notes the distinction; the prototype sequence still mixes both sides.

**Plan change:** First prototype: **Bob remains single-device.** Treat recipient multi-device sync as a later gate, same as history sync.

### P1 — Live handshake vs prekeys: proposal is consistent; later sections fight it

**Fact:** Chat is plaintext JSON over verified transport (`chat-wire.ts`); no app E2EE/prekeys in messaging. Identity can derive X25519 but mobile unused.

**Correct (design):** An always-on Alice holder can wait for Bob and use today’s live handshake; prekeys are **not** required for that path.

**Contradiction:** Later “shared work” still gates on independently authenticated encryption before any remote store, and the mailbox sequence diagram / stored-state table remain the mental model. A **full linked device** is not a ciphertext mailbox: the holder _is_ an Alice endpoint and sees plaintext.

**Plan change:** Split prerequisites: linked full-device path → multi-device auth + durable sync; mailbox/ciphertext-helper path → E2EE/prekeys. Do not list PQXDH as a linked-device MVP dependency. Mailbox/E2EE/hosted remain **non-goals / comparison only**.

### P1 — Hosted full device trust is honestly stated; still stronger than a mailbox

**Fact/opinion:** Operator of a hosted full device can read sync content and send as the user (device keys). Disk encryption does not fix a live process. Doc is right to refuse “content-inaccessible” marketing and to defer hosting.

**Plan change:** Keep hosted out of prototype entirely. If revisited, treat as “QOP-operated second phone,” not encrypted storage.

### P2 — Discovery: library support real; QOP unused; relay ≠ Bob online

**Fact:** minip2p 0.5.3 has optional `discovery` (signed beacons, TTL, topic) and `peerDiscovered` / `peerUpdated` / `peerExpired` (`@minip2p/core` `types.ts`). QOP configures relays only and listens for `relayReserved` / connections (`p2p-store-core.ts`); no discovery/pubsub. Reach Bob today via registry `peerId` + `connect`.

**Correct:** Relay reservation is not a subscription to arbitrary-contact presence. Shared discovery topics create traffic/metadata cost; contact-scoped design is unfinished.

**Plan change:** MVP dial Bob’s **registered** peerId (and dial Alice’s CLI via known multiaddr/VPS). Measure discovery later; do not block the durability demo on mesh membership.

### P2 — Later comparison still reads mailbox-first

Internal tension (editorial, but it will mislead implementers):

| Early (linked-device main) | Later (original comparison) |
| --- | --- |
| Prototype own devices first | Experiments still centered on mailbox/DHT acceptance |
| States: queued / saved on own device / delivered | Shared states: accepted for forwarding / stored for recipient |
| Prekeys optional for live holder | Shared gate: E2EE before third-party store |
| Success = extend availability via own devices | Offline-requirements table still “storage must hold copy” without naming holders |

**Plan change:** Relabel later mailbox/DHT material as **fallback comparison**; lead experiments with linked phone+CLI; keep one mailbox experiment only as the control for “no always-on own device.” (Done in main plan lead.)

### P2 — Product promise gap (opinion grounded in facts)

Linked devices help only after **another own device has accepted** the pending send. Sleeping laptop / closed phone with no CLI = today’s local outbox. Default users without a VPS/desktop do not get Alice-disconnects-first delivery. Doc admits this; decision tables should make that the explicit MVP service promise, not an afterthought. **Now locked:** always-on CLI MVP promise; phone-only unchanged.

---

## Verified vs opinion (short)

| Item | Label |
| --- | --- |
| Current send/ack/manual-retry/no auto-outbox | **Verified** |
| Single device key; live registry verify | **Verified** (to be replaced by locked multi-key model) |
| No app E2EE; JSON frames | **Verified** |
| Relays on; signed discovery off in QOP | **Verified** |
| minip2p discovery events exist in 0.5.3 | **Verified** |
| Relay ≠ contact presence subscription | **Verified** |
| No desktop/CLI/outbox sync in repo | **Verified** |
| Linked-device first is best next build | **Design opinion** (reasonable; now Project direction) |
| Prekeys unnecessary for live-holder path | **Design opinion** consistent with code |
| Will meet default-user availability | **Unproven**; phone-only unchanged by design |

---

## Simplest viable prototype

1. **Auth (recommended first):** `addDevice` / `removeDevice`; Bob verifies any active key for Alice’s `qid`; live-connection revoke (max age / recheck / invalidate); contacts by `qid` + roster; recovery wipe-all; preserve history on remove. Hard-cut from single `deviceKey`.
2. **Ship** a headless CLI with its own key, durable disk outbox, process restart.
3. **Sync** pending text + delivery obligations phone↔CLI; handoff ACK only after durable save; keep phone copy.
4. **Deliver** with existing `/qop/chat/1` live handshake to Bob’s registry peerId (no discovery, no prekeys, Bob single-device).
5. **Prove** the kill-phone / restart-CLI / Bob-returns / one-message / receipt-back demo; then add dual-holder + lost-ACK + revoke tests.
6. **Defer** hosted endpoint, E2EE/prekeys, discovery mesh, Bob multi-device catch-up, attachments, push.

---

## Merits prototyping?

**Yes**, as the main candidate: it matches “messages travel peer to peer” better than a default mailbox, reuses live transport crypto, and only needs always-on _user-owned_ capacity. Multi-device authorization (on-chain keys, live revoke) is the first deliverable; phone-only offline delivery remains unchanged until the user runs an always-on CLI (or a later hosted/mailbox product decision).
