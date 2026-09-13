<!-- Independent review produced by Grok CLI with --model grok-4.6 on 2026-09-12.
Session: 01a096cf-9bb2-79d2-b330-9d27965e1ab1
Reviewed plan: docs/research/cli-device-linking-plan.md
Repository baseline: 9443fe0, plus the uncommitted plan and CONTEXT.md.
Reviewer wording is preserved; CLI progress messages and trailing whitespace were removed.
Recommendations are reviewer proposals, not accepted changes. Some citations and
suggested fixes need verification. In particular, AddDeviceV1 has no owner field,
and clock drift alone has not been established as a suspend-safe authorization rule.
-->

# Design review: CLI device linking

**Verdict: changes required.** Phone-approved QR pairing plus API-sponsored `addDevice`/`removeDevice` matches the contract, identity codecs, and registration-relay machinery. The plan is not ready to implement as written: it never specifies how the signed intent and status reach the CLI or survive crashes, and its CLI freshness rule cannot be implemented with the existing session code without breaking consecutive operations on a quiet chain.

Accepted scope (QR pairing, phone approval, sponsored add/remove, durable handoff later) is not in dispute.

---

## Blockers

### 1. Signed intent/status never have a specified path to the CLI, and crash persistence is only named, not designed

**Severity:** Blocker **Kind:** New-plan gap (existing registration already solved this on the phone)

The phone is the submitter (`docs/research/cli-device-linking-plan.md:32-34`, `:47-49`). The CLI is told to verify the owner signature against a fresh account read (`:47`) and to keep “transaction metadata” across restart (`:49`). Nothing specifies:

- the pairing-stream messages after approval (intent, signature, digest, API status),
- which process talks to the API,
- what “transaction metadata” is,
- when each side durably writes that data.

Registration already persists the digest **before** the relayer can see the request:

```349:352:mobile/src/lib/local-registration-core.ts
        // Save the digest before the request can reach the relayer.
        yield* writeStoredRegistration(request);
        const result = yield* registrationClient
          .register({ admissionCode, intent: canonicalIntent, ownerSignature })
```

Device linking has no analogue on phone or CLI.

**Failure:** Alice taps Link. The phone signs and `POST`s the add. The pairing stream drops before the CLI learns the digest. CLI restart “has not seen submission,” issues a new QR for the same pending key (`:49`). The phone, with no persisted digest, reads a still-current account nonce and signs again with a new deadline → new digest → second relayer transaction. One reverts or both spend gas; neither side can reconcile to a single in-flight operation. Kill-after-submit (`:104`) is unimplementable.

**Smallest amendment:** Copy the registration pattern:

1. After pairing, the phone reads owner/nonce/roster, signs, and **atomically stores** `{digest, intent, signature, deviceKey, qid, status: pending}` before any API call.
2. It then sends that record on `/qop/pair/1`. The CLI **persists the same digest/intent** before showing “submitted.”
3. The phone submits to the API. Status is `GET` by digest on the phone; the CLI may poll the API **or** only watch `qidByDeviceKey`/`isActiveDevice` for its key. Either is fine if written down.
4. On restart: if a pending/submitted digest exists, **do not sign again**. Reconcile membership first, then API status. A new QR is allowed only when no digest is in flight and no submitted tx has unknown outcome.
5. Closing the scanner after step 1 cannot unsign; it can only stop waiting on the stream.

Until this sequence is in the plan, “CLI verifies the owner signature” is not a specified protocol.

---

### 2. Uncached membership plus existing non-advancing-head rejection is not implementable for “every sensitive CLI operation”

**Severity:** Blocker **Kind:** New-plan vs existing sessions

The plan (`:85-87`) wants a fresh uncached membership check before every CLI sensitive op, **and** the shared freshness rules (stale-tagged and non-advancing heads refused).

Existing `verify` does two different things:

```118:128:mobile/src/lib/p2p-sessions.ts
            const cached = session.authorization;
            if (cached) {
              if (cached.contact.handle !== handle) {
                session.authorization = undefined;
                return yield* new PeerVerificationError({
                  operation: "identity",
                });
              }
              if (authAgeMs(cached) < MAX_AUTH_AGE_MS) {
                return cached.contact;
              }
            }
```

```180:190:mobile/src/lib/p2p-sessions.ts
            // Require freshness === "fresh" (above) AND a strictly newer head.
            const priorBlock = session.lastConfirmedBlockNumber;
            if (priorBlock !== undefined && account.blockNumber <= priorBlock) {
              session.authorization = undefined;
              return yield* new PeerVerificationError({
                operation: "identity",
              });
            }
```

`lastConfirmedBlockNumber` is remembered across `invalidateAuthorization` (`:87-93`, `:222`). Tests treat same-head as a hard fail (`mobile/test/p2p-sessions.test.ts:401-418`, `:470-492`; `mobile/test/registry-auth-freshness.test.ts:86-111`). There is no “skip cache” switch.

`isVerified` is still a 60s cache with **no** chain read (`mobile/src/lib/p2p-sessions.ts:269-276`). `performSend` calls `verify` then `isVerified` (`mobile/src/lib/p2p-send.ts:136-141`).

**Failure:** Skip the 60s cache and keep the current `<= priorBlock` rule. First diagnostic message confirms at Anvil head `N` and stores `lastConfirmedBlockNumber = N`. Second send, same connection, chain idle → `blockNumber <= priorBlock` → identity failure. Bob never sees the second message. Mining a block before **every** CLI send is not a production rule and is easy to omit in the acceptance demo.

Resume-during-in-flight-verify **is** already implemented (`verifyEpoch`, test at `mobile/test/p2p-sessions.test.ts:534-567`). The missing piece is Node stall/suspend, not in-flight cancel.

**Smallest amendment:** Do not skip positive cache on CLI. Share `createPeerSessions` as-is:

- 60s monotonic cache while running,
- `invalidateAuthorization` on detected stall/suspend (wall vs monotonic drift is enough on macOS/Linux),
- stale/non-advancing rejection **only on the post-invalidate re-read**,
- Anvil: mine when a re-read needs a newer head, not before every send.

If a later CLI wants uncached checks, that is a new `verify` mode that allows same-block success unless `verifyEpoch` changed. That mode does not exist today.

---

### 3. “Narrowly scoped” add/remove signing is unspecified, and the existing vault patterns disagree

**Severity:** Blocker for unauthorized enrollment **Kind:** New-plan gap, with an existing-code trap

`@qop/identity` can hash/recover add/remove but **cannot sign them** (`packages/identity/src/index.ts:86-88` exports `signRegisterIntentV1` / `signWipeDevicesIntentV1` / `signRecoverOwnerIntentV1` only). That much is planned work.

The danger is which vault pattern gets copied.

Registration signing binds handle, owner, and **this phone’s** device key:

```382:388:mobile/src/lib/identity-vault-core.ts
      if (
        intent.handle !== identity.handle ||
        intent.owner !== identity.ownerAddress ||
        intentInput.deviceKey !== (yield* publicIdentity(identity)).deviceKey
      ) {
        return yield* vaultError("sign");
      }
```

Wipe/recover sign whatever intent the caller passes (`mobile/src/lib/identity-vault-core.ts:398-419`). Domain is never checked against app config in the vault. Copying wipe for `addDevice` means any caller who can reach the vault can enroll an arbitrary unused key. Copying register’s `deviceKey === local device` check makes CLI enrollment impossible (the CLI key is not the phone key).

The API will sponsor any valid owner signature (`docs/research/cli-device-linking-plan.md:57-59`). Pairing is not an API authz boundary. The vault **is**.

On-chain, owner uniqueness (`contracts/src/QOPIdentityRegistry.sol:90`, `:275-292`) stops adding to someone else’s account, but it does not stop adding an attacker key to Alice’s account.

**Failure:** Approval UI pins the QR key. A bug or extra caller invokes `signAddDeviceIntent` with a different `deviceKey`. The API simulates, pays gas, and the attacker’s key is live. Alice’s fingerprint screen never ran for that key.

**Smallest amendment:**

- `signAddDeviceIntent(domain, intent, expectedDeviceKey)` refuses unless `intent.deviceKey === expectedDeviceKey` (the key-pinned pairing result), `intent.owner`/`qid` match a fresh read of **this** owner, and `domain` matches the app’s configured chain/registry — not the QR’s copies.
- `signRemoveDeviceIntent` binds the same domain/account and the user-selected roster key.
- Do not copy wipe/recover’s unbound signer.

---

## Important (fix in the plan before coding the API)

### 4. Device-action confirmation cannot reuse registration’s “nonce used” probe

**Severity:** Important **Kind:** New-plan vs existing API

Registration confirms by `registrationNonceUsed` at a **confirmed** head (`api/src/registration/enrollment.ts:289-317`, `api/src/registry/chain.ts:96-110`, `:204-254`). Add/remove have no equivalent flag. Account `nonce` advances for rotate/wipe/recover too (`contracts/src/QOPIdentityRegistry.sol:294-296`, `:314-316`, `:333-334`). The API account cache is 15s fresh / 1 min stale (`api/src/registry/reader.ts:68-83`) and does not even call `qidByDeviceKey` (`api/src/registry/abi.ts:8` is unused in `chain.ts`).

The plan correctly says Linked is membership, not a submitted tx (`:34`, `:63`). It does not say how the API maps a digest to `confirmed` / `reverted`, or that `cached.account()` is unsafe for nonce checks.

**Failure:** Reuse `markConfirmed` when “the account nonce moved.” Alice’s concurrent `removeDevice` or `wipeDevices` confirms a still-pending add digest. UI shows the CLI linked because the add digest is `confirmed`, while `qidByDeviceKey(cliKey)` is 0. The plan’s own anti-pattern (`:63`) happens inside the API.

**Smallest amendment:** For device actions, confirm **only** from a receipt at the configured confirmation depth **plus** a membership read at that block (`isActiveDevice` / `qidByDeviceKey` for add; inactive + `deviceKeyRemoved` for remove). Validate and simulate against **fresh** (or `eth_call`) state, never `cached.account()`. `confirmed` on a digest is historical; “currently linked” is always a live roster read.

Local demo: set API `REGISTRY_CONFIRMATIONS` to the same policy as the clients (Anvil: 0 + mined receipt). Do not leave API at 12 and clients at “included.”

---

### 5. Digest idempotency does not serialize two different intents for one account

**Severity:** Important **Kind:** New-plan (registration only unique-indexes handle/owner)

Registration uniqueness is per digest, plus active handle/owner (`api/src/db/schema.ts:67-80`). Add/remove digests include deadline, so two approvals in one nonce window are two rows. Plan says serialize per account (`:59`) but does not specify the store constraint.

**Failure:** Double-tap Link (or Link + Remove) produces two signatures with account nonce `k` and different deadlines. Both pass digest idempotency, both take relayer nonces from `registration_relayer_state` (`api/src/registration/store.ts:352-368`), both broadcast. One reverts `NonceConflict` (`contracts/src/QOPIdentityRegistry.sol:522-524`); gas is spent; the UI races.

**Smallest amendment:** At most one `ready|submitted` device action per `qid`. Second intent gets an explicit nonce/in-flight conflict; the phone must re-read and re-sign. After `reverted`, that digest is terminal; require a new signature (new deadline) rather than replacing serialized bytes in place unless you specify replacement.

---

### 6. Shared relayer nonce is real, and easy to break by cloning

**Severity:** Important **Kind:** Existing code, amplified by the plan

Durable allocation exists and is process-safe: singleton row, `FOR UPDATE`, persist signed bytes and hash, skip re-prepare when already `submitted` (`api/src/db/schema.ts:112-121`; `api/src/registration/store.ts:321-368`, `:337-342`; rebroadcast in `api/src/registration/enrollment.ts:216-256` and `api/src/registration/relayer.ts:177-204`). Tests show later prepares use `max(chain, nextNonce)` (`api/src/test/registration-store.test.ts:134-165`).

`prepare()` does RPC **inside** that transaction (`store.ts:352-357` → `relayer.ts:145-151`). That serializes **all** sponsorship, including registration vs device actions.

**Failure:** Device actions get `device_relayer_state`. A registration prepare and an add prepare both read pending nonce `7`, both sign nonce 7, one is lost. Or the lock is held across a slow `eth_estimateGas` and registration queues behind every add.

**Smallest amendment:** Reuse `registration_relayer_state` (rename later if you want). Do not add a second allocator. Keep admission vs device **authorization** separate, as the plan says (`:61`). Optionally: allocate the nonce and persist placeholder under the lock, run `prepare`/simulate outside it, then write serialized bytes — existing code does not do this; only needed if lock time becomes a problem.

---

## Improvements

### 7. Phone P2P currently cannot carry `/qop/pair/1`

**Severity:** Improvement / practical **Kind:** Existing mobile endpoint vs new pairing stream

The running phone endpoint advertises only `/qop/chat/1` (`mobile/src/lib/p2p-store-core.ts:472-477`, `mobile/src/lib/chat-wire.ts:4`). Inbound unknown protocols are reset (`p2p-store-core.ts:562-570`).

**Failure:** Scanner opens `/qop/pair/1` on the live chat endpoint. Depending on minip2p (not verified here), the stream never opens, or an inbound pair stream on the phone is a new auth surface.

**Smallest amendment:** Phone endpoint advertises chat **and** pair; **reject inbound** pair; only the CLI listens for pair, and only during `qop link`. After `qop start`, do not accept pair. Confirm this against the pinned `@minip2p/node` / `@minip2p/react-native` 0.5.3 APIs before building UI.

**Uncertainty:** I did not run minip2p; whether `openStream` requires the local node to list the protocol is unverified.

---

### 8. 4 KiB QR budget is larger than a reliable QR

**Severity:** Improvement **Kind:** New-plan practicality

Plan allows 4 KiB and four full multiaddrs (`:43`, `:49`). Typical version-40 QR binary capacity is under 3 KiB.

**Failure:** Terminal QR with two relay addrs plus keys/secret will not scan; users fall back to paste. That is acceptable only if paste is a first-class path (the plan does say that).

**Smallest amendment:** Size the encoding to a scannable QR (short binary/base64, not JSON), keep paste as equal validation, not an afterthought.

---

## Checks the user asked for, if not already a finding

| Question | Result |
| --- | --- |
| Fresh/non-advancing check before every CLI sensitive op, using existing sessions | **No.** See finding 2. Existing sessions can skip cache only by changing `verify`; combined with `lastConfirmedBlockNumber` that fails the next op at the same head. `isVerified` still trusts 60s with no chain read. |
| How signed intent/status reach the CLI and survive crashes | **Not specified.** See finding 1. Phone registration **does** persist digest before submit; device linking must copy that on **both** phone and CLI. Membership of the pending key is enough to display Linked after a crash **if** no second signature is created. |
| Pairing trust / key possession | Plan is sound **if** the transport peer ID is the QR key (`:45-47`) and minip2p authenticates that PeerId. Possession is the Noise/libp2p handshake, not the challenge echo. **Uncertainty:** not verified against minip2p 0.5.3. |
| QR replay / cancel | Reject unknown version / expired / non-current session id is enough if the CLI only accepts the **current** in-memory session and restart mints a new id (`:49`). Consume-at-handshake vs consume-at-approval is still open. Cancel-before-submit vs after-submit (`:51-52`) is right; it depends on finding 1’s persisted digest. |
| Owner signature / domain binding | Contract and `packages/identity` typed data are already correct (`AddDeviceV1` / `RemoveDeviceV1` in `packages/identity/src/registry-intents.ts:93-117`, `:161-177`; contract `:275-316`). Clients must sign the **local** domain, not the QR’s. Vault must enforce that (finding 3). |
| Unauthorized enrollment | API will enroll any valid owner signature. Pairing does not protect the API. Vault binding is the control (finding 3). QR substitution of the CLI key is inherent; the fingerprint (`:31`) is the user check — keep it, don’t pretend the QR is authenticated to Alice. |
| On-chain confirmation / reorg | Local policy (`:81`) is fine for Anvil. Production finality is correctly deferred (`:83`). Do not treat API digest `confirmed` as currently linked (finding 4). |
| Auth freshness / suspend | Phone path is implemented: `AppState` → `invalidateAuthorization` (`mobile/src/lib/p2p-store.ts:23-35`, `p2p-store-core.ts:519-525`). CLI has no equivalent; finding 2 is the replacement. Bob’s 60s bound after remove is existing and matches acceptance (`:106`). Existing `verify` does **not** check the **local** device’s membership; revocation is enforced by the recipient. That is enough for the stated Bob-rejects-removed-CLI test. |
| Shared relayer nonce | Exists and works if reused (finding 6). |
| Scope / complexity | `packages/protocol` for pairing codecs + sessions + registry reader is justified (do not fork auth). Moving chat DB/Zustand would be extra; the plan already avoids that (`:71`). |

**Existing-code facts the plan already got right (not findings):** four-device cap and removed keys cannot return (`contracts/src/QOPIdentityRegistry.sol:64`, `:92-93`, `:456-459`, `:482`); shared account nonce; mobile `RegistryAccount` decodes nonce and drops it (`mobile/src/lib/registry-core.ts:84-86`, `:259-266`, `:105-116`); sessions already accept phone+CLI as one qid without `keyChanged` (`mobile/src/lib/p2p-sessions.ts:216-220`).

---

## Remaining decisions before implementation

1. **Status channel:** CLI polls the same API the phone uses, vs CLI is membership-only after receiving the digest. If CLI polls, give it its own trusted API URL (not in the QR — the plan is right about that at `:43`).
2. **CLI freshness mode:** keep 60s cache + stall invalidate (recommended), vs new same-block-allowed uncached mode. Do not ship the plan’s literal combination.
3. **When the pairing session is consumed:** first successful handshake vs after signed intent is persisted. First-handshake-wins prevents a second phone from pairing the same QR; it also lets an observer with the QR block Alice for five minutes.
4. **Device-action deadline cap** (registration uses 3600s in `api/src/registration/enrollment.ts:64`) and per-account/IP quota numbers, including a reserved remove budget.
5. **Reverted digest policy:** terminal + re-sign, or same digest new relayer tx.
6. **Node stall detector:** `Date.now()` vs `performance.now()` drift threshold. CLOCK_MONOTONIC on Linux/macOS typically **pauses during sleep**, which is why cache-only CLI auth would miss a revoke overnight.
7. **Local `REGISTRY_CONFIRMATIONS`** aligned with “mined receipt + membership” (`:81`). Tests already use `0` (`api/test/registration-enrollment.test.ts`); example env uses `12`.

---

## Proposed implementation sequence

The plan’s five steps (`:89-95`) stay in the same order, with these inserts:

0. **Write the pairing post-approval record and persist-before-submit state machine** (finding 1) into the plan, including CLI restart / phone restart / double-QR behavior. Do not start the scanner until this is explicit.
1. Interop check for minip2p Node/RN 0.5.3, including “can the phone open `/qop/pair/1` on the existing endpoint.” Pairing codecs + extract the **minimum** of `p2p-sessions` / `registry-core` / chat wire. Add a CLI verify policy: **same cache and freshness as today**, plus stall invalidate — not uncached-every-op.
2. `signAddDeviceIntentV1` / `signRemoveDeviceIntentV1` in identity; vault bindings from finding 3; expose nonce on the mobile registry snapshot (`registry-core.ts` already decodes it). Device-action API on the **existing** `registration_relayer_state`, unique in-flight row per `qid`, receipt+membership reconciliation (findings 4–6). Concurrent registration + add test first.
3. `qop link` identity store (atomic key persist, file lock, permissions) → QR → phone scanner → persist-before-submit → both sides watch membership. Cancellation and kill-recovery tests from `:104` before roster UI.
4. Roster/remove, `qop start`/`status`, one diagnostic chat. Do not require a new Anvil block per message.
5. Real-device run; README/API “used only once” updates (`README.md:5,13`, `api/README.md:12`, `mobile/README.md`).

I did not modify the plan or any repo files.
