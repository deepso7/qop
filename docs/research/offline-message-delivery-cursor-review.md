# Cursor review of offline message delivery

Requested through Cursor CLI on September 10, 2026, using `--model auto --mode ask --print`. The CLI exited successfully. Auto selected the model; the underlying model was not reported. The review below is preserved as returned, including its recommendations. It reviews [the research report](offline-message-delivery.md) and the subsequent proposal for direct delivery with mailbox fallback.

## Reading notes from Codex

These qualifications apply to the review below:

- F5 conflates duplicate arrivals with identifier collisions. Multiple delivery paths produce intentional duplicates; they do not by themselves make random UUID collisions more likely. Authentication and uniqueness scope still matter for hostile IDs.
- The proposed product statement calls identity P2P, but QOP's identity authority is its on-chain registry. Peer transport and identity resolution are separate dependencies.
- Outbox-only delivery can remain pending until both peers overlap online. Describing that as "both-offline loss" overstates it unless the remaining copy is deleted or otherwise lost.
- Permissionless participation and the ability to leave a provider are related but distinct. Self-hosting alone does not establish permissionlessness, and direct delivery's latency advantage needs measurement.

## Cursor's response

# Offline delivery architecture review

## 1. Overall assessment

The research doc is a solid failure-mode survey, and its codebase claims match HEAD (`e0cc503`). Today QOP only delivers when both peers are reachable on a live minip2p stream. Chat payloads are plaintext JSON over that transport. There is no automatic outbox, no application E2EE, no mailbox, no push, and no DHT usage in app code.

The proposed direction (durable outbox + async E2EE + direct when reachable + self-hostable ciphertext mailbox with a QOP default, DHT deferred) is the right _shape_ for the product. It is not yet a shippable plan. The decision-changing gaps are product honesty about what “P2P by default” means once a store exists, the async crypto and receipt model, and whether a second delivery path earns its complexity once a default mailbox is always available.

Evidence labels below: **fact** = verified in repo/docs; **inference** = reasoning from those facts; **unverified** = not checked against live networks or third-party deployments in this review.

---

## 2. Prioritized findings

### F1. Application E2EE is a hard prerequisite for any third-party store

**Fact.** `ChatFrameV1` is JSON (`fromHandle`, `id`, `sentAt`, `text`) with no ciphertext fields (`mobile/src/lib/chat-wire.ts`). Send/receive write that frame on a verified stream (`p2p-send.ts`, `p2p-store-core.ts`). `@qop/identity` can derive an X25519 public key (`packages/identity/src/device-encryption.ts`); messaging does not use it.

**Consequence.** Depositing today’s frames in a mailbox exposes plaintext to the operator. “Add a mailbox” without an independent authenticated envelope is a security regression, not an offline feature.

**Resolution.** Spec and implement the offline envelope (sender auth, recipient binding, replay/id binding, session/prekey rules) before any storage protocol. Treat sealed boxes alone as insufficient (research note on sender auth / forward secrecy is correct).

### F2. Current `sent` means recipient device ACK; a mailbox breaks that contract

**Fact.** Outbound status becomes `sent` only after an ACK matching `frame.id` on the live stream (`p2p-send.ts`, `p2p-store-core.ts`). UI treats `sent` as delivered meta (`conversation-screen.tsx`). Status enum has no stored/queued remote state (`db.ts`).

**Consequence.** If mailbox acceptance is shown as `sent`, Alice believes Bob has the message when only a server does. That is a product and trust bug, not a polish issue.

**Resolution.** Keep distinct durable states: local queue → store accepted → device delivered (and optional read). Collapse in UI only with an explicit design, and never collapse store acceptance into today’s `sent`.

### F3. Default QOP mailbox conflicts with current public claims unless those claims change

**Fact.** README: “Messages travel peer to peer… The only server in the picture is a small registration API that a client uses once, then never again.” AGENTS.md: secure and P2P by default; self-hostable without compromising decentralisation or permissionlessness. App already requires `EXPO_PUBLIC_RELAY_ADDRS` to start (`p2p-store-core.ts`); relays are connectivity helpers, not message stores. Offline delivery is explicitly deferred (`mobile/README.md`).

**Inference.** A QOP-hosted default mailbox is a lasting operator dependency for delivery availability, quotas, abuse, and likely push. That is a different centralization than one-shot registration or Circuit Relay. Self-hosting optionality does not remove default dependence for users who never change settings.

**Consequence.** Shipping the proposed default without updating positioning creates an architectural contradiction: marketing says no ongoing messaging servers; reality is store-and-forward for offline cases (and possibly most sends if clients always deposit).

**Resolution.** Decide the service promise in writing: which functions still work when every QOP-operated host is down. Update product language before implementation. Prefer a design where self-host / multi-mailbox is a first-class path, not a buried advanced setting, if independence is a real goal.

### F4. Dual-path delivery is justified only if direct remains a real primary path, not a timeout prelude

**Fact.** Research proposes brief direct try, then mailbox (or a race). Mobile OS background limits mean peers are often unreachable even when the phone has network (research cites Apple/Android/FCM docs; **unverified** here against QOP builds).

**Inference.** If the client always falls through to the mailbox after a short dial, most messages still hit the mailbox. Two code paths, one dominant traffic pattern. Complexity cost is real: shared IDs, duplicate suppression across paths, racing receipts, and UI for partial success.

**Consequence.** The user’s objection is strongest against “direct-first” that is decorative. Dual path pays for itself when (a) an already-open verified session prefers direct with no mailbox deposit, or (b) mailbox outage still allows online chat, or (c) metadata/latency goals require avoiding the store when both sides are live.

**Resolution.** Bound the dual path: define when direct is attempted, whether mailbox is skipped on live session success, and maximum dial budget from device measurements. If policy is “always deposit for reliability,” choose mailbox-first and keep P2P for sessions, presence, and mailbox transport, not as a second message store path.

### F5. Duplicate suppression is UUID-global and not sender-authenticated

**Fact.** `INSERT OR IGNORE` keys only on message `id` (`db.ts`). Wire UUID is sender-chosen (`chat-wire.ts`, `sendMessage` uses `randomUUID()`).

**Inference.** Research is right that an attacker-chosen UUID must not suppress another sender’s message. Dual delivery plus mailbox redelivery makes collisions and cross-path duplicates more likely.

**Consequence.** Wrong uniqueness scope causes silent message loss under adversarial or buggy IDs.

**Resolution.** Deduplicate on authenticated (sender device, conversation, message id) material from the E2EE layer, not bare UUID primary key alone.

### F6. Crash-safe decrypt/save/ack and deferred receipts are missing from the current stack

**Fact.** Receive path inserts, then ACKs on the same stream (`p2p-store-core.ts`). Failed/interrupted outbound becomes `failed` and needs manual `retryMessage`. No receipt channel that works while Alice is offline.

**Consequence.** Mailbox delete-on-ack without durable local save loses messages. Store acceptance without a later device receipt leaves Alice stuck at “stored.” Lost receipts need their own store path (research sequence diagram with Alice’s mailbox for receipts).

**Resolution.** Spec Alice and Bob crash windows before coding storage RPCs. Require save-before-consume-key and save-before-store-ack. Plan receipt delivery with the same retention rules as messages.

### F7. First-contact and key rotation are unsolved for true async send-by-handle

**Fact.** Registry exposes one device key per account; no prekeys or mailbox descriptors (`registry-core.ts`). Connection auth re-checks registry per live connection (`p2p-sessions.ts`, `mobile/README.md`).

**Inference.** Offline first message to a handle needs published key material (prekey bundle or invite-carried keys) plus a rotation/staleness policy. Device-key rotation during a delayed message can brick ciphertext retained past key retention.

**Consequence.** Without this, “async E2EE” only covers existing contacts who already exchanged material. Public first-contact through a default mailbox becomes an introduction-spam and crypto-design problem.

**Resolution.** Product choice first: invite-only async intro vs public handle intro. Then prekey publication site (invite, contact exchange, later registry/DHT). Align retention with old-key retention.

### F8. Push creates another QOP-shaped dependency even if ciphertext stays elsewhere

**Fact.** No APNs/FCM usage under `mobile/src`. Research infers a restricted push gateway for stock iOS because APNs credentials belong to the app vendor.

**Inference.** Self-hosted mailboxes that want timely alerts still need a way to wake the stock app. That can recenter notification power on QOP even when message storage is diversified.

**Consequence.** “Decentralized storage” can still feel centralized for UX. Gateway outage should delay alerts only; app-open fetch must remain correct (research already states this).

**Resolution.** Treat push as optional latency, not delivery. Document gateway trust and rate limits. Test with push disabled as a first-class mode.

### F9. Distributed storage / DHT message holding is the wrong next build for QOP

**Fact.** App code has no DHT record API usage. Research documents short TTLs / nonpersistent defaults in common DHT stores and high ops cost for Session-like swarms. Complexity table ranks those options high to very high.

**Inference.** Building placement, repair, and funding to avoid a mailbox replaces one operator problem with a harder network-operations problem, against AGENTS.md simplicity preferences.

**Consequence.** Starting there delays the actual prerequisites (outbox, E2EE, receipts) that every option needs.

**Resolution.** Keep DHT deferred for message bodies. Revisit only for mailbox _discovery_ if contact-exchanged descriptors prove insufficient.

---

## 3. Answer to the P2P-versus-mailbox objection

The objection is valid as a design stress test. If every message is deposited in a mailbox “because we have one,” P2P is no longer the delivery system. It is dialing code around a server inbox. That does conflict with “messages travel peer to peer” as currently written.

What still justifies P2P under a mailbox model:

1. **Connectivity is not storage.** QOP already uses relays to make dials work. That does not hold ciphertext after both phones leave. Offline delivery needs a holder. Calling that holder a mailbox does not erase the need.
2. **Online sessions can stay direct.** When a verified stream exists, deliver on it, ACK on it, and skip the store. Lower latency, less operator metadata, works if the mailbox is down.
3. **Transport and identity stay peer-oriented.** Peer IDs, registry-bound device keys, and authenticated streams remain the trust base. The mailbox should see opaque envelopes and deposit credentials, not messaging keys.
4. **Permissionlessness is about exit, not about zero helpers.** Self-hostable (or multi-operator) stores preserve exit from QOP’s default. A default-only store that is required for basic chat does not.

What does _not_ justify two paths:

- Always racing or always uploading “for safety” after a token direct attempt, then claiming a P2P messenger.
- Using the mailbox as the only ACK Alice ever sees.

**Clean product statement (inference):** QOP is peer-to-peer for live delivery and identity. Offline delivery uses encrypted, recipient-chosen store-and-forward. A QOP-hosted default is convenience, not the trust root for plaintext and not the only allowed store.

If that statement is unacceptable, do not ship a default mailbox. Ship durable outbox + direct retry only, and accept the both-offline failure the research names as fundamental.

---

## 4. Fair comparison

| Approach | Passes “Alice gone, Bob returns alone”? | Fit to QOP now | Main cost | Main honesty risk |
| --- | --- | --- | --- | --- |
| Direct-first + mailbox fallback | Yes, after store accept | Best match if direct stays real for live sessions | Two paths, shared IDs/receipts, dial budgets | Pretending traffic is mostly P2P when it is not |
| Mailbox-first (P2P for live sync optional) | Yes | Simpler ops story; matches SimpleX/Briar-shaped helpers | Always-on metadata/latency; stronger default-host dependence | README “only registration server” is false unless rewritten |
| Distributed storage (DHT bodies / swarm) | Only with real persistence + repair policy | Poor near-term fit (no DHT API in app; high build/ops) | Membership, repair, abuse, mobile retrieval completeness | Claiming decentralisation while retention is soft or unpaid |

**Direct-first/mailbox-fallback.** Right if QOP wants measurable live-path benefits and mailbox-outage resilience for online pairs. Needs strict rules so the fallback is not the silent default on every send.

**Mailbox-first.** Right if mobile reachability is usually false and dual-path bugs are the larger risk. P2P remains how clients talk to mailboxes and to each other when both are up for session features. Delivery narrative should lead with encrypted store-and-forward.

**Distributed storage.** Right only if the product requires no operator choice and automatic repair without phones. That is a different company-shaped project than a minimal messenger on minip2p. Research already separates discovery DHT from storage DHT; neither should block outbox + E2EE.

---

## 5. Decisions and bounded experiments before implementation

Settle these before writing storage code:

1. **Service promise.** Max offline retention (7 / 14 / 30 days), single-device only for v1, attachment policy deferred or not.
2. **Independence bar.** On total QOP host outage: must live 1:1 still work? Must offline delivery work for self-hosters only? Must default users lose offline only?
3. **Delivery policy.** Live verified session: direct-only vs also deposit. No session: mailbox-only vs short direct probe. Numbers from device tests, not guesses.
4. **First contact.** Invite-carried keys only vs public async intro to a handle.
5. **Status model.** Exact mapping from queued / stored / delivered to UI copy.
6. **Push.** Required for MVP or app-open fetch only.

Bounded experiments (cheap relative to building a swarm):

| Experiment | Done when |
| --- | --- |
| Both-offline retrieval against one mailbox process | Bob alone fetches after Alice disconnects, within stated retention |
| Process restart after accept | Accepted ciphertext still present |
| QOP default down, self-host up | Offline delivery still works for that contact |
| Direct success with mailbox unreachable | Online chat works; no false “stored” |
| Crash between decrypt, save, store-ack | No plaintext loss; no store delete before local durable save |
| Push disabled on real devices | Eventual delivery on app open |
| Prekey/invite stale after rotation | Defined user-visible failure, no silent drop |

Defer DHT body storage and swarm repair until those pass on a mailbox design.

---

## 6. Conditional recommendation

**If** QOP accepts rewriting the “only server is registration” claim into “P2P live delivery + optional encrypted store-and-forward, default hosted, self-hostable,” **and** commits to async E2EE and distinct stored vs delivered states first, **then** proceed with: durable automatic outbox → async E2EE envelope → recipient mailbox protocol on a minip2p peer → QOP default + documented self-host → opportunistic direct on live verified sessions without mandatory deposit → DHT still deferred.

**If** the product must keep “no ongoing messaging servers” as a hard principle, **then** reject the default mailbox. Ship outbox auto-retry and E2EE for the live path only, and treat both-offline loss as an accepted limit until a non-default personal mailbox (Briar-style) exists without a QOP-operated inbox.

**Prefer mailbox-first for the first offline MVP** if device tests show direct probes rarely succeed for typical mobile contacts. Keep direct as the live-session fast path so P2P is not ornamental. Do not start with replicated storage networks.

**Confidence: medium.** High confidence on current-code gaps (plaintext frames, ACK semantics, no outbox/mailbox/push, registry limits). Medium on dual-path vs mailbox-first because that hinges on unmeasured mobile reachability and on how strongly the team holds the no-server claim. Low confidence on third-party DHT/swarm operational numbers; this review did not re-verify external deployments beyond the research doc’s citations.

**Unknowns.** Real dial success rates and safe timeouts on iOS/Android with minip2p 0.5.3; whether a QOP push gateway is mandatory for acceptable UX; encryption library choice and multi-device timeline; willingness to change README positioning before coding.
