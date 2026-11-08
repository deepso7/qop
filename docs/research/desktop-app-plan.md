# Desktop app (Rune)

Status: implementation plan, November 8, 2026. Based on `8e39c28`. Revised after two GPT 6.1 Sol (high) review passes; see "Review log" at the end. Second-pass fixes are not yet re-reviewed.

The user chose a standalone native desktop app built with [Rune](https://github.com/anomalyco/rune) (Rust, GPU-rendered). The desktop is a **linked device only**: it cannot register an account, recover one or create invites. It joins an existing account through phone approval, exactly like the CLI, and then chats as that account.

TypeScript stays the source of truth for identity and protocol (`@qop/identity`, `@qop/protocol`). The desktop carries a small Rust implementation of the subset a linked device needs, kept honest by shared golden test vectors. A shared Rust core for all clients is explicitly out of scope; revisit it only if most clients end up in Rust.

## Outcome

Alice opens QOP Desktop for the first time, enters her handle, and sees a QR code. She scans it from Profile > Devices > Link device on her phone (paste remains a fallback) and approves. The desktop independently confirms on chain that its device key is an active member of Alice's account, then shows her conversations. She can message Bob from the desktop and receive his replies; the phone can hand off pending text to it and catch up replies it stored over `/qop/sync/1`. Removing the desktop from the phone stops it from messaging as Alice and returns it to the pairing screen.

Completion requires a real phone/desktop demonstration on macOS covering: link (QR and paste), restart with the same identity, restart mid-enrollment, send, receive, offline queueing with retry, phone handoff and catch-up, and removal.

## Non-goals (v1)

- Registration, recovery keys, invites, owner signing of any kind. The desktop never holds an owner secret.
- Approving other devices from the desktop (owner actions stay on the phone).
- Windows and Linux builds (Rune supports them; ship macOS first, keep code portable).
- Showing desktop-sent messages on the phone. Catch-up only carries the linked device's inbox (`cli/src/sync.ts:186`); receipts cover known outbox IDs. This gap is shared with the CLI and is tracked separately.
- Notifications, tray icon, auto-update, code signing/notarization pipeline (follow-up milestone).
- Moving minip2p, identity or protocol logic out of TypeScript for other clients.

## Reference implementation

The CLI (`cli/src`, ~4k lines) and the shared protocol modules it uses already implement every behavior the desktop needs. The desktop ports them module by module; when in doubt, the TS code and the CLI e2e docs (`docs/testing/cli-device-linking-e2e.md`, `cli-online-chat-e2e.md`, `phone-cli-handoff-e2e.md`) define correct behavior.

| TS source | Desktop equivalent |
| --- | --- |
| `cli/src/config.ts` | `config.rs`: RPC URL, registry address, chain ID, API URL, relay addrs. As built, all from env: `QOP_RPC_URL` and `QOP_REGISTRY_ADDRESS` are required, the chain ID defaults to 31337, the rest are optional; production defaults are still to bake in (see Risks). Public endpoints only, no secrets. |
| `cli/src/identity-store.ts` | `identity.rs`: device Ed25519 key in the macOS Keychain; non-secret metadata (handle, qid, peer ID, link state, removal marker) in SQLite. Single-instance lock. |
| `cli/src/pairing-link.ts`, `pairing-session.ts`, `pending-approval.ts` | `pairing.rs`: offer generation, `selectPairingAddrs` ranking, `/qop/pair/1` handler, claim rules, owner-signature and account checks, approval persistence, same-record replay, conflict rejection. |
| `cli/src/enrollment-poll.ts`, `device-action-status.ts`, `protocol/src/membership.ts` | `enrollment.rs`: API status + chain membership polling with the terminal/absent/unknown distinctions in `membership.ts`. |
| `protocol/src/registry-reader.ts` | `registry.rs`: ABI, handle hashing, account snapshot (owner, nonce, devices), registry head capture and pinning (`registry-reader.ts:203`). |
| `protocol/src/p2p-sessions.ts`, `contacts.ts`, `lifecycle.ts` | `auth.rs`: per-connection authorization with `MAX_AUTH_AGE_MS`, fresh membership against a strictly newer head (`p2p-sessions.ts:204`), rejection of verifications invalidated in flight (`:246`), contact/QID binding, lifecycle invalidation on sleep/resume. |
| `cli/src/chat.ts` | `chat.rs`: chat protocol in/out, authorization bound to the actual connection (`chat.ts:207`), recheck immediately before writing (`:300`), roster dialing, inbound stream limits and timeouts. |
| `cli/src/outbox.ts`, `outbox-store.ts`, `protocol/src/outbox.ts` | `outbox.rs`, `store.rs`: SQLite `outbox`/`inbox` with `OutboxRecordV1` / `InboxRecordV1` semantics and the same conflict rules. Statuses are `queued`, `sent` (recorded after the recipient ACK), `failed`. |
| `cli/src/sync.ts`, `protocol/src/sync*.ts` | `sync.rs`: `/qop/sync/1` handoff, `held`, receipts, catch-up. |
| `cli/src/process-lifecycle.ts` | `lifecycle.rs`: macOS sleep/wake via the app shell instead of SIGCONT; feeds `auth.rs` invalidation. |

## Architecture

New Cargo crate at `desktop/` (binary `qop-desktop`), outside the pnpm workspace. Pin Rune to a `dev` rev and minip2p to `minip2p-rs` tag `v0.11.6` via git dependencies; record both in the README and bump minip2p together with the JS bindings.

```
desktop/
  Cargo.toml
  src/
    main.rs          bootstrap: prewarm GPU, open store, start node + engine, run Rune
    config.rs
    wire/            Rust port of the identity/protocol subset (pure, no IO)
    node.rs          minip2p endpoint owner thread
    engine/          pairing, enrollment, auth, chat, outbox, sync (tokio)
    registry.rs      alloy provider + registry reader
    store.rs         rusqlite
    ui/              Rune views
  tests/vectors/     golden vectors (generated by TS)
```

**minip2p embedding.** `minip2p-rs`'s std endpoint is caller-driven (blocking `wait`, non-blocking `poll`), not a self-running task, and relay is an optional feature. A dedicated **node thread** owns the endpoint: it loops on `wait`, uses the `wait_handle` to wake for commands from the engine, drains events, and forwards stream data/events over channels. Enable the same capabilities the JS bindings enable in `crates/ffi-core/Cargo.toml` (relay, NAT/DCUtR, identify) so network behavior matches the CLI. Specify and test stream write completion, half-close (pairing and sync rely on it, `pairing-io.ts:49`), and clean shutdown.

**Engine.** A tokio runtime for RPC, API and protocol logic. It talks to the node thread over channels and to the UI through Rune's background handle (`handle.update(|s, tx| ..)`, as in Rune `examples/background`). The UI sends typed commands to the engine over mpsc. The UI never touches the network or SQLite.

**Crates.** `rune`, `rune-kit`, `minip2p-rs`, `tokio`, `alloy` (provider, sol-types EIP-712, signature recovery), `rusqlite` (bundled), `keyring`, `qrcode`, `serde`/`serde_json`. Prefer minip2p's identity types for keys and peer IDs over parallel crates.

## State model

One explicit top-level state enum, in the style of the state machines from #31:

```
Unlinked
  -> Pairing { offer, expires_at }                 accepts /qop/pair/1
  -> AwaitingEnrollment { approval, status }        accepts /qop/pair/1 for recovery only
  -> Linked { account }
  -> Revoked                                         wipe; Start over -> Unlinked
```

Rules, ported from `pairing-session.ts`, `pending-approval.ts`, `enrollment-poll.ts` and `docs/research/cli-device-linking-plan.md`:

- **Recovery while awaiting enrollment.** If the phone never received `approvalSaved`, it never submits (`mobile/src/lib/device-link-flow-core.ts:87`). So `AwaitingEnrollment` can show a fresh offer with the _same_ device key; a hello plus the identical approval record replays `approvalSaved` without re-checking nonce/deadline (`pairing-session.ts:222`). A different approval gets `approvalConflict`.
- **Pending approval transitions.** Evaluated in this order on every poll and on startup, matching `enrollment-poll.ts`, `pending-approval.ts:71`, `pairing-link.ts:240` and `occupiesApprovalSlot` (`membership.ts:63`):

  | Observation | Transition |
  | --- | --- |
  | Own key is an active member | `Linked` |
  | Own key was added and later removed (removal marker, `enrollment-poll.ts:48`) | Rotate to a fresh device key (a removed key cannot return), clear the approval, `Pairing` |
  | API status `expired` or `reverted` | Clear the approval immediately, keep the key, `Pairing` |
  | API has no record of the digest **and** chain time strictly after the deadline | Clear the approval, keep the key, `Pairing` |
  | Anything else (`ready`, `submitted`, `confirmed` not yet observed on chain, API or RPC unreachable, deadline passed but API still has the digest) | Keep the approval, stay in `AwaitingEnrollment` |

  Clearing promptly matters: once the phone's slot is released it may sign a replacement intent, which a stale saved approval would answer with `approvalConflict` (`mobile/src/lib/local-device-action-core.ts:402`).

- **Pending enrollment UI** offers only "Stop waiting", which hides progress but keeps the state and the recovery pairing path. Unlink is available only in `Pairing` (no approval yet) and `Linked`.
- **Revocation requires affirmative chain evidence.** Periodic membership checks, resume, and authorization failures _trigger_ a fresh self-membership read; they never wipe on their own. A remote peer failing verification, an RPC error, or a stale/stuck registry head (`p2p-sessions.ts:177`, `:204`, `:220`) only pauses messaging until verification succeeds. Only a successful read showing the desktop's key removed from the account stops messaging, wipes the key and local messaging data, and shows `Revoked` with an explanation until Start over returns to `Unlinked`.
- **Membership gating ships with receiving.** Milestones 3 and 4 enforce linked membership before any messaging; milestone 6 only adds the removal UI and polish.

## Wire compatibility: golden vectors

The Rust `wire/` and `registry.rs` must match the TS packages. A TS script writes `desktop/tests/vectors/*.json` from the real TS encoders and decoders using fixed keys, nonces and timestamps:

- device secret key -> device key -> peer ID -> pairing fingerprint
- `PairingOfferV1` (`qop-pair1.` string) including address lists and sizes at the limits
- `PairingFrameV1`: `hello`, `helloAck`, `approval`, `approvalSaved`, `approvalConflict`
- EIP-712 domain separator, `AddDeviceIntentV1` digest, a signature, the recovered signer (remove intents are owner actions; not needed in v1)
- `DeviceActionApprovalV1` encoding and approval digest
- registry calldata and ABI-encoded responses for every read the desktop makes; handle hashing (`registry-reader.ts:376`)
- device-action API status responses (`cli/src/device-action-status.ts:6`)
- `ChatFrameV1` / `ChatAckV1`; every `Sync*V1` request and response
- **acceptance and rejection cases per public decoder**, generated from that decoder's actual behavior: unknown version, non-canonical decimals and hex, high-s or bad-parity signatures (`wire-codecs.ts:34`), malformed UTF-8, oversize frames, mismatched keys. Unknown-field handling differs by decoder: pairing is strict (`pairing.ts:213`), while chat frames, chat ACKs and API status responses accept extra fields (`chat-wire.ts:62`, `device-action-status.ts:46`). The Rust decoders keep each one's existing behavior.

TS tests assert the committed vectors still match the encoders. Rust tests check that each decoder accepts or rejects exactly the same inputs as its TS counterpart and that Rust-produced bytes equal the TS bytes. Separate Rust tests cover stream framing (fragmented reads, EOF and half-close), which byte fixtures cannot. A protocol change requires: TS change, regenerate vectors, Rust change, both suites green.

## User flow

1. **First launch.** Ask for the account handle; resolve it on chain. Generate and durably store a fresh device key _before_ showing any QR.
2. **Pairing screen.** Wait for a relay reservation (fall back to LAN addresses), then render the QR and a Copy button for the `qop-pair1.` payload, with an expiry countdown (`PAIRING_TTL_SECONDS`) and Regenerate.
3. **Phone approves.** First valid hello from an active device of the expected account claims the session. The desktop verifies the owner signature against a fresh account read, checks key/qid/chain/registry/nonce/deadline, persists the approval, then sends `approvalSaved`.
4. **Linking progress.** "Waiting for confirmation" while polling API status and chain membership. Linked only after the desktop's own chain read confirms membership. Restarting resumes the same state.
5. **Linked.** Conversation list (local SQLite), "New chat" by handle, chat view with composer. Message states: Queued, Delivered (`sent`, i.e. recipient ACKed), Failed. Inbound messages are saved before acking.
6. **Phone handoff and catch-up.** Accept `/qop/sync/1` only from the account's own active devices; reply `held` after persisting, send receipts after the recipient ACKs, serve catch-up.
7. **Removal.** See state model.
8. **Settings.** Account, peer ID, fingerprint, link state, relay status, data location, Unlink (where allowed; tells the user to also remove the device on the phone).

## Phone changes

The phone's link flow is device-agnostic (`PairingOfferV1` has no device type or label; `mobile/src/lib/pairing-client-core.ts:81`), but the Link device screen only accepts pasted text and tells the user to run `qop link` (`mobile/src/app/link-device.tsx:170`, `:283`). Add:

- a QR scanner (expo-camera) that feeds the same validation and approval path as paste;
- neutral instructions covering both desktop and CLI.

No protocol change.

## Milestones

Each milestone is a separate PR and is usable on its own.

1. **Vectors and wire.** TS vector generator + committed vectors; `desktop/` crate skeleton with `wire/`, `registry.rs` decoding and vector tests. No UI.
2. **Pairing.** Node thread, Rune window with handle entry, QR and countdown, `/qop/pair/1`, approval persistence and recovery, enrollment polling, restart mid-enrollment. Phone QR scanner and copy changes. Demo: phone scans and links the desktop; both show Linked.
3. **Receive.** Linked gating, `auth.rs` (head pinning, connection binding, in-flight invalidation, lifecycle), inbound chat saved to SQLite, conversation list and read-only chat view.
4. **Send.** Composer, outbox with retry while running and after restart, roster dialing, recheck before write, message states.
5. **Sync.** `/qop/sync/1` handoff, receipts, catch-up. Demo follows `phone-cli-handoff-e2e.md`.
6. **Removal and polish.** Revocation UI and wipe, settings, error states, headless Rune snapshots for each screen.

### Milestone 2 as built

- `identity.rs` became `store.rs` (SQLite: identity, pending approval, revoked marker; single-instance `flock`) and `keys.rs` (device secret). The secret defaults to a 0600 `device.key` file: on macOS 27 a rebuilt, ad hoc signed binary blocks on a Keychain password prompt to read the item its previous build created. `QOP_KEY_STORE=keychain` opts in; revisit with code signing.
- Chain reads are `rpc.rs`, a small blocking JSON-RPC client (`ureq`) with head pinning, run on tokio's blocking pool, instead of an alloy provider. `api.rs` reads device-action status the same way.
- A pending approval that the API reports `confirmed` keeps its slot until the desktop's own read shows membership (the table above), where `occupiesApprovalSlot` would release it.
- `qop-desktop --headless` runs the engine without a window, prints one line per model change (offer codes included) and takes button presses on stdin; e2e runs use it (`docs/testing/desktop-linking-e2e.md`).

### Milestones 3 and 4 as built

- Modules: `engine/auth.rs` (sessions and the messaging gate), `engine/lifecycle.rs`, `engine/chat.rs`, `engine/outbox.rs`; messages live in the existing `store.rs` (migration v2: `contacts`, `outbox`, `inbox`), not a separate store. E2e: `docs/testing/desktop-chat-e2e.md`.
- Sleep/wake: Rune exposes no wake notification, so `lifecycle.rs` ports the CLI's clock-gap detector (wall vs monotonic, stall, backwards step), observed every second by the engine. A platform signal can call `Lifecycle::mark_interrupted` later.
- Authorization reads use a new `lookupDeviceKey` port (`rpc.rs`), always pinned to a captured head, so TS `freshness: "fresh"` always holds and the stale case is "head not strictly newer". A stale head or RPC failure is its own `VerifyError` so the engine can pause on it.
- Linked gating: messaging starts `Verifying` and turns `Ready` only on the desktop's own membership read, which must also be at a head strictly newer than its last one. RPC errors, stale heads, a lifecycle invalidation, a contact's RPC/stale verification failure, and a peer refusing our frame after we wrote it pause and re-read; a plain peer identity failure does not (any peer could otherwise pause us). Reads repeat every 2 s while paused, every minute while ready. Only the removal marker revokes; revocation and Unlink also wipe messages.
- The desktop dials contacts by peer ID through the relay (no mDNS/discovery yet), so without a relay it reaches only peers that dialed it. Contact connections wake the outbox for that account, ignoring backoff.
- `Store::put` updates only, unlike the CLI's: a delivery that finishes after a wipe must not reinsert its record.
- Conversations are keyed by contact QID; unread is the inbox rowid past the contact's `read_seq`. Messages arriving in the last opened conversation are marked read.
- The `live` scene renders a real `QOP_DATA_DIR` headless (used when a window screenshot is not possible).
- For milestone 5: register `/qop/sync/1` next to chat in `start_node`; serve it from `node_event` behind `Auth::allowed()`, verifying the phone with `Auth::verify` against the own handle and QID; `held` after `Store::enqueue`; receipts from the outbox's `Sent` transition (`Internal::OutboxChanged`/`deliver_one`); catch-up pages from the inbox rowid (add an `inbox_after(seq, limit)` query).

### Milestones 5 and 6 as built

- `engine/sync.rs` ports `cli/src/sync.ts`: sync streams are served only while messaging is `Ready`, share chat's inbound stream limit, and the peer is verified on its own connection as an active device of our own handle and QID before the request is read and again before anything is stored. `held` follows `Store::enqueue`; receipts are read from the outbox (`sent` is only ever written after the recipient's ACK) rather than pushed; catch-up reads `Store::inbox_after` and packs under the 64 KiB cap. A handoff to someone who is not yet a conversation adds one, so the desktop shows phone-composed messages in that chat. E2e: `docs/testing/desktop-sync-removal-e2e.md`.
- Removal needs no new mechanism: the once-a-minute own-membership read sees the registry's removal marker (53 s in the e2e run), stops the node, wipes, and shows `Revoked`; Start over deletes the key, so the next link pairs with a fresh one.
- Errors stay calm and never block: `model::Unreachable` (chain or API) from the last poll, shown as one notice line in the linked view (also for re-checking membership and no network) and under enrollment progress. Settings shows the real account, peer ID, fingerprint, link state, relay and data directory (`live-settings` scene renders it from a data directory).
- Performance: the engine keeps the newest `PAGE` (200) messages per conversation and reloads only the conversation an event touched (`Store::thread`, on new `(to_qid, sent_at)` / `(from_qid, received_at)` indexes, migration v3); messages are shared (`Arc<[Message]>`), so publishing copies none. The thread is an index-built virtual list (`El::virtual_rows`), and reaching its top asks for another page (`Command::LoadEarlier`). Debug-build numbers with a 5,000-message conversation open: 1.4 ms idle frame, 3.8 ms per frame while scrolling, ~15 ms for a frame that swaps in a new 5,000-message thread (78 ms before virtual rows); the newest page of 5,000 stored messages reads in 0.9 ms (`ui::tests::frame_cost…`, `store::tests::reads_the_newest…`).
- Not done: a real phone run (the app's QR scan, handoff, catch-up and removal UI), and noticing a removal sooner than the minute poll (a peer refusing us already triggers a re-read; a quiet desktop waits for the poll).

## Testing

- Vector tests (above), including rejection cases and stream framing.
- Ports of the CLI's tests for `pairing-session`, `pending-approval` and `enrollment-poll`, plus every row of the pending approval table and lost `approvalSaved` / conflicting approval.
- `auth.rs` tests: stale or same-head RPC result, connection replaced mid-verification, invalidation during verification, recipient QID mismatch.
- Revocation tests: peer rejection, RPC failure and a stuck head pause messaging but preserve the key and local data; only an affirmative removal read wipes.
- Store tests: outbox/inbox conflict rules match `outboxRecordsConflict` / `inboxRecordsConflict`.
- Rune headless snapshots (PNG + element tree) for pairing, linking, empty/populated conversation list, chat, revoked.
- Manual e2e against local Anvil + API + phone dev build, as `docs/testing/desktop-*.md` adapted from the CLI docs.

## Risks and open questions

- **Rune is pre-release** and takes no PRs. Pin a rev; budget time for upgrades; file issues for blockers. Text input, IME and accessibility are the likeliest problems.
- **Keychain on unsigned dev builds.** Prompts and access behavior of `keyring` need a runtime check in milestone 2; fall back to a 0600 file (the CLI's approach) if it gets in the way during development.
- **Production config.** Checked-in examples only have local values (`mobile/.env.example`). Confirm production registry, chain, API and relay values before release.
- **Drift.** Two implementations of a protocol subset, mitigated by vectors that include rejection cases and by keeping the subset small and versioned.

## Review log

GPT 6.1 Sol (high), first pass. All findings accepted:

1. Approval recovery could deadlock in `AwaitingEnrollment` → recovery pairing with the same key and same-record replay.
2. Peer authorization was underspecified → `registry-reader`, `p2p-sessions`, `contacts`, `lifecycle` mapped explicitly, with tests.
3. Enrollment outcomes and wipe boundaries → explicit expiry, added-then-removed, Unlink restrictions; gating moved to milestone 3.
4. minip2p runtime assumption was wrong → dedicated node thread on the caller-driven endpoint, features matched to `ffi-core`.
5. Vectors too thin → ABI/API fixtures, handle hashing, strict rejection cases, correct pairing variants, stream framing tests.
6. Phone had no QR scanner → phone changes section and milestone 2 scope.
7. Outbox states → `queued` / `sent` (shown as Delivered) / `failed`.

GPT 6.1 Sol (high), second pass. Confirmed fixes 1, 2, 4, 5, 6, 7. Accepted:

1. Authorization failure implied revocation → wipe only on affirmative chain evidence of local removal; failures pause messaging.
2. Approval clearing didn't match the CLI → explicit transition table (terminal `expired`/`reverted` clear immediately; deadline alone never releases `ready`/`submitted`/unknown). Also corrected added-then-removed to rotate the key and keep pairing, as `pairing-link.ts:246` does.
3. Unknown-field rejection is decoder-specific → per-decoder expectations.
4. Remove-intent signing fixtures were unused → dropped from v1.
