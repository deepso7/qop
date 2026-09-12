# Offline message delivery for QOP

## MVP promise (LOCKED 2026-09-11)

**An always-on CLI holds Alice’s pending sends so delivery can continue when her phone is offline.** Desktop and other linked devices come later. Phone-only users keep today’s behavior: no silent “messages wait in the cloud” claim, and no guarantee of delivery after the phone disconnects unless another of her devices has already accepted the pending send.

**Non-goals for this slice:** hosted/VPS mailbox as the default path; full desktop app; third-party ciphertext stores; app E2EE / PQXDH / prekeys as MVP dependencies. Mailbox, DHT, and hosted-store material later in this document is **fallback comparison only** — do not expand implementation scope from those sections.

**Locked auth model:** on-chain multi-device keys (`addDevice` / `removeDevice`) under existing `owner` custody. Breaking registry/client changes are OK (hard-cut; no soft migration / dual-read of single `deviceKey`). The repo-local [multi-device authorization plan](multi-device-auth-plan.md) defines the implementation sequence, acceptance checks, and remaining decisions.

**Still open:** phone↔CLI sync contract (handoff transport, record schema, ack/conflict/completion). Finality and RPC-failure defaults remain **proposal**. Max auth age is **implemented** at **60s** monotonic elapsed time (`MAX_AUTH_AGE_MS`). **Sequencing (proposal — not locked):** land auth including live-connection revoke **before** phone↔CLI outbox sync.

## Overview

The build direction is durable delivery through Alice’s always-on CLI (linked full device), after multi-device auth lands. Alice’s phone synchronizes a pending message to her CLI; that device keeps the message and delivers it when Bob becomes reachable. A personal VPS can run the CLI continuously later; hosted QOP instances and mailboxes are out of this slice.

This extends availability beyond the composing phone only after another own device accepts the pending send. Research below still compares mailbox/DHT alternatives for context; they are not the MVP path.

## Main proposal: linked devices carry pending sends

### Delivery flow

1. Alice's phone saves the message and its pending delivery obligation together.
2. It sends immediately if an authorized Bob device is reachable. It also synchronizes the message and delivery state with Alice's available linked devices.
3. Alice's desktop or CLI acknowledges the handoff only after saving enough state to resume delivery after a restart. The phone retains its copy.
4. Alice can close her phone. A holder attempts delivery when it discovers an authorized Bob device or when a bounded retry becomes due.
5. Bob's device saves the message before acknowledging it. Alice's holder saves the receipt and synchronizes it to her other devices.
6. Bob's devices synchronize the received message separately. Delivery to his desktop does not mean his phone has received or displayed it.

A recipient desktop can also accept while its owner's phone is absent. Both sides benefit from linked devices. Neither side must route every live message through a designated server.

| State | Meaning |
| --- | --- |
| Queued locally | The composing device holds the pending send |
| Saved on another own device | That device accepted responsibility to retry; Bob has not necessarily received it |
| Delivered | At least one authorized Bob device persisted the message |
| Read | Bob's application sent a separate read receipt, if enabled |

These are proposed protocol meanings; the final UI can use simpler wording. Keep the receiving device and known holders in internal state. If every holder is offline, delivery waits. If the phone closes before another device accepts the message, the message remains dependent on that phone. A laptop must be awake, connected, and running QOP. A background desktop window does not prevent OS sleep.

### What existing systems establish

Jami's synchronization design describes device announcements triggering peer channels that exchange contact and conversation metadata, followed by history retrieval. This is a useful precedent for own-device synchronization. The page retains draft language and links an implementation review; it is not evidence of QOP's reliability. QOP can use a durable queue without adopting Jami's Git repositories. [40](https://docs.jami.net/developer/jami-concepts/synchronization-protocol.html)

Signal's Sesame describes separate device records and sessions, including sessions to a sender's own other devices. It assumes server mailboxes, so its relevance here is session management. It does not establish a serverless delivery mechanism. [39](https://signal.org/docs/specifications/sesame/)

### Device identity and authorization (LOCKED: on-chain multi-device keys)

**Auth model (LOCKED):** Keep `owner` as custody. Authorize N active Ed25519 device keys per `qid` with owner-signed `addDevice` / `removeDevice` (EIP-712 + nonce/deadline). Keep `qidByDeviceKey` for **every active** key. Device-agnostic under that `qid` (multi-mobile + CLI/desktop).

**Not the multi-device path:** Do **not** present `rotateDevice` (single-key replace) or `rotateDevice` ping-pong as how a second device joins. Optional later convenience only; CLI MVP needs add+remove. Do **not** share one device key across phone and CLI.

**Hard-cut (LOCKED — breaking OK):** Replace the single-`deviceKey` account model cleanly. No soft migration, dual-read of legacy primary-only mapping, or compatibility shims that keep “one primary peerId” as SoT while pretending multi-key works.

**Verify:** transport `peerId` → deviceKey → `qidByDeviceKey` → account handle/`qid` match. **Do not** require `account.peerId === connection.peerId` where `peerId` is derived from a single primary `Account.deviceKey`.

**Enrollment:** CLI generates its own device key. Phone (owner) signs add; anyone may relay. Cap N small (proposed default: 4). Do not copy recovery/owner material to the CLI.

**Live revocation on existing connections (LOCKED — must-have for MVP):** Today `p2p-sessions` caches `session.contact` for the connection’s life. After `removeDevice`, Bob must stop accepting that peer within a defined bound on **existing** P2P connections (recheck triggers, invalidate on failed recheck / observed remove). “Next connect only” is rejected as the sole revoke story. Authorization age uses **monotonic elapsed time** (not wall-clock) while running; on resume from sleep/suspend, invalidate cached authorization and require fresh registry verification before sensitive ops (do not pause age across sleep). Stale/cached RPC success must not reset age. **Implemented:** max auth age **60s** monotonic elapsed time (`MAX_AUTH_AGE_MS` in `p2p-sessions`). Finality policy and RPC-failure behavior remain **proposal** (recommended: refuse after age — see the [auth plan](multi-device-auth-plan.md)).

**Contacts:** Key contacts by `qid` (+ handle) with a **device roster** / last-seen device. Authorizing a second concurrent device is **not** `keyChanged`. Reserve `keyChanged` / security badge for unexpected or untrusted key change; roster add/remove is a distinct signal (“linked a device” / “removed a device”). v1 minimum: no false “key changed” when Alice’s CLI connects.

**Owner recovery after compromise (LOCKED):** Remove **all** existing devices; devices must be re-added. Do not leave any prior device authorized after owner recovery.

**History on remove (strong requirement):** Removing a device must **not** delete or tombstone already-accepted conversation history on any peer (unlike Farcaster hub drop-of-signer-messages). Revoke only blocks **new** auth/delivery as that device; local plaintext already stored stays.

**Presence:** A presence beacon authenticates a peer key, not permission to act for Alice — registry membership does.

Synchronize logical messages and delivery obligations only **after** auth (including live revoke) is proven. Let each full device establish its own sessions. Do not clone mutable encryption-session state into concurrent devices.

For this candidate, an online Alice CLI can wait for Bob and perform a live authenticated handshake. Published prekeys are **not** a prerequisite for this MVP. Pre-encrypting to an absent Bob device and the mailbox/E2EE material later in this report are **comparison / non-goals** for this slice — do not pull them into the linked-device build.

Start sync with contacts, authorized-device metadata, pending messages, and receipts. Initial history transfer is a separate feature. Attachment delivery requires another holder to have the bytes, not merely a local file path on the absent phone.

Allow several devices to retry. Deduplicate by authenticated sender account and logical message ID; reject conflicting content under an existing ID. Bob must acknowledge duplicates again when an earlier receipt was lost. Synchronize completion records so an old device cannot restore a completed send from stale state. Retention of those records must cover the retry window. A preferred worker may reduce duplicate traffic, but correctness should not require a permanent leader or exclusive queue ownership.

### Finding Bob without continually dialing every contact

Use discovery and connection events to trigger work for destinations with pending messages. Reconcile after reconnecting or restarting, then use jittered backoff to recover from missed events and failed connections. Avoid automatically dialing every peer visible on a shared topic.

minip2p 0.5.3 exposes discovery events and pubsub subscriptions. Its discovery uses periodic signed beacons over a connected mesh and maintains expiring peer records. Presence does not establish that a usable route exists. QOP currently configures relays but does not enable signed discovery on its endpoint. [41](https://minip2p.com/reference/typescript-api/) [42](https://minip2p.com/rust/discover-peers/)

A relay reservation is not a subscription to arbitrary Bob-presence updates. Pubsub subscriptions require peers that propagate the relevant messages. Known VPS addresses can provide a stable route; unknown or changed addresses still need discovery. A shared topic creates traffic and metadata exposure, so contact-scoped discovery needs separate design and measurement. [43](https://minip2p.com/typescript/networking-and-events/)

The prototype should establish discovery membership, authenticate announced devices against account authorization, and measure bytes and connection attempts as pending destinations grow. Test missing announcements, expired addresses, and loss of the shared mesh. Event-triggered delivery reduces repeated attempts, but discovery still has periodic traffic. There is no measured efficiency claim yet.

### Personal and hosted deployment (comparison / later)

| Deployment | Access and responsibility | This slice |
| --- | --- | --- |
| Own desktop or CLI | A full authorized device stores the synchronized content and retries while it runs | **CLI MVP path** (desktop later) |
| Own VPS | The same device role, with durable disk and process supervision; the host can access the running endpoint | Optional later ops; not required for auth milestone |
| QOP-hosted full device | QOP operates an authorized endpoint with access to its synchronized content and messaging keys | **Non-goal** |
| Optional ciphertext-only helper | Holds prepared encrypted envelopes; requires a separate forwarding protocol and has narrower capabilities | **Non-goal / comparison** |

A hosted full device changes the trust boundary. Encryption between devices does not hide content from the operator of an endpoint that can decrypt it. Disk encryption does not prevent a live host administrator from inspecting that process. Do not advertise this offering as content-inaccessible to QOP — and do not build it in this slice.

A ciphertext-only helper can reduce that access, but cannot compose messages or re-encrypt for Bob's new keys. It is a separate optional role described only in the mailbox comparison below.

### Prototype and decision gates

Build no hosted service, mailbox, or app-E2EE path in this slice. **Recommended sequencing (proposal — not locked by Deepso):** prove multi-device auth (with live-connection revoke) **before** phone↔CLI outbox sync. Do not implement outbox sync against single-device auth.

1. **Auth milestone (first — recommended):** Registry `addDevice` / `removeDevice` + `qidByDeviceKey` for all actives (hard-cut from single `deviceKey`). Reader + `listActiveDevices`. Change `p2p-sessions` (drop primary-`peerId` equality; recheck live conns within max auth age; invalidate on revoke). Contacts keyed by `qid` + roster (no false `keyChanged` on second device). Prove: Bob accepts Alice phone **and** Alice CLI as the same `qid`; `removeDevice` stops that device within the live-session bound **including** an existing connection; the other device keeps working; already-accepted history remains after remove. Owner recovery after compromise wipes all devices / re-add.
2. **Then** specify phone↔CLI sync records, content-conflict rule, and completion retention (still open). Link Alice's phone and headless CLI with distinct keys. Keep Bob single-device for the first durability demo. Implement durable outbox synchronization and receipt reconciliation for text messages. Use known reachable addresses and bounded dialing initially to isolate durability from discovery.
3. Demonstrate the phone handing off a message, closing, the CLI restarting, and Bob returning later. Bob must display one logical message and Alice's phone must learn its receipt when reopened.
4. Add event-triggered attempts and bounded recovery. Measure idle traffic, per-pending-contact traffic, time to delivery, duplicate attempts, and behavior when discovery or QOP relays fail.
5. Exercise two simultaneous holders, lost acknowledgments, stale device lists, revocation (live + next connect), recipient device replacement, sleeping laptops, queue limits, and expiry. Define failure behavior before treating this as reliable offline delivery.
6. Add Bob-side device synchronization as a separate gate before promising delivery to any Bob device in the product. History sync, attachments, mobile wakeup, and hosted trust remain later / non-goals for this slice.

**MVP service promise (locked):** always-on CLI holds Alice’s pending sends; phone-only users unchanged. The design succeeds if users can extend availability through their own always-on device, with clear pending states when no holder is reachable. Mailbox / distributed storage comparison below is retained only if that availability bar cannot be met later — it is not an alternate MVP implementation path now.

## Fallback comparison only: what P2P contributes when a mailbox exists

> **Non-goal for this PR / slice.** The sections from here through the storage-candidate experiments are retained as research comparison. Do **not** treat them as implementation prerequisites for the always-on CLI MVP. Linked full-device delivery does **not** need app E2EE, PQXDH, or prekeys.

Every message could go through a mailbox. Calling that mailbox an always-on peer describes its transport, but it still acts as a storage server. QOP therefore has two decisions to make: who stores offline messages, and whether live messages bypass storage.

Direct delivery earns its implementation cost when an online conversation skips mailbox uploads, continues during a mailbox outage, or transfers attachments without a server copy. Skipping storage also keeps those transfers out of the mailbox operator's view. Any latency or battery advantage needs measurement. Independently authenticated message encryption is necessary for third-party storage whichever delivery policy QOP chooses.

| Delivery policy | Behavior | Tradeoff |
| --- | --- | --- |
| Direct delivery with mailbox fallback | A successful live delivery skips storage; unreachable peers use a mailbox | Two paths require shared message IDs, duplicate handling, receipts, and a bounded connection attempt |
| Mailbox-first | Upload every message and let recipients fetch or subscribe | One main delivery path, with storage-provider dependence even for online conversations |
| Local outbox with direct retry | Keep trying until both peers are reachable together | No remote storage requirement, but Bob cannot receive while Alice and every other holder remain offline |

A distributed storage network changes who holds the messages. It does not eliminate the need for another device to hold them while both phones are absent.

The current [README](../../README.md) says the registration API is the only server involved. A default mailbox would change that claim. Before shipping, the product description must explain ongoing storage and notification dependencies. Identity also remains anchored in the on-chain registry, regardless of the delivery path.

For a direct-delivery candidate, use this policy in the experiment: send on an available verified connection and skip mailbox upload after a recipient acknowledgment. Without a connection, compare a short connection attempt against immediate mailbox upload. A timed-out send may already have arrived, so both paths must tolerate duplicates. Do not claim most traffic travels directly until measurements show it.

For a mailbox-first candidate, test uploading immediately without a preliminary peer connection attempt. Compare delivery time, traffic, battery use, and failure behavior against the direct-delivery candidate. The existence of P2P code alone is not a reason to retain both paths.

## Scope and evidence

The MVP scope is always-on CLI durable sends for one-to-one text after multi-device auth. First contact, mobile notifications, attachments, hosted endpoints, and mailbox/E2EE are out of this slice (comparison material only where retained). The initial comparison was checked on September 10, 2026; linked-device research was added on September 11, 2026; locked MVP/auth decisions were applied to this plan on September 11, 2026. QOP was inspected at commit `e0cc503652502a3e8c7051da099d8ae1911b62ef`, with `@minip2p/react-native` 0.5.3 installed.

The findings come from documentation and source code. Reliability and complexity comparisons are engineering judgments; no network benchmarks or cryptographic audits were run. Source notes identify development branches and older material.

The [linked-device Cursor CLI review](offline-linked-devices-cursor-review.md) supports a sender-side phone-and-CLI prototype and correctly flagged multi-device auth as the blocker; Project locks now pick on-chain multi-device keys. The review is advice, not protocol validation.

The earlier [Cursor CLI review](offline-message-delivery-cursor-review.md) assesses the mailbox-oriented architecture. Treat it as **historical comparison**; its preference for a default mailbox / async E2EE path is **not** the locked MVP direction.

## What offline delivery requires

Alice sends while Bob is offline, then disconnects. Bob returns alone. For him to receive the message, another reachable device must still have a copy. This is the basic test for every option.

Several different conditions can look like an offline peer:

| Condition | Required behavior |
| --- | --- |
| Alice has no connectivity | Save locally and retry when QOP can run with network access |
| Bob has no connectivity | Retain an encrypted copy outside Bob's device |
| Bob has connectivity but QOP is suspended | Retain the message, attempt notification, reconcile when QOP runs |
| Both phones are offline after upload | Storage must maintain the copy without either phone's participation |
| Bob's chosen storage is unavailable | Use another authorized store, an outbound forwarding service, or keep the local queue pending |
| Bob returns after retention expires | Recover from another retained copy if possible; do not claim guaranteed delivery |
| Bob replaced his device or keys | Apply an explicit key-change and recovery policy |

QOP needs to state how long accepted messages remain available and which failures it tolerates. A store accepting a message, Bob saving it, and Bob reading it are separate events. An acknowledgment records a promise; it cannot prove future availability.

## Current QOP behavior

QOP saves outgoing messages before sending and incoming messages before acknowledging them. A matching acknowledgment sets the sender's status to `sent`. Failed and interrupted sends require manual retry. The database ignores duplicate UUID inserts and displays messages by local arrival order. Automatic outbox retries and remote-storage status are still missing. See [p2p-store-core.ts](../../mobile/src/lib/p2p-store-core.ts), [p2p-send.ts](../../mobile/src/lib/p2p-send.ts), and [db.ts](../../mobile/src/lib/db.ts).

The [chat frame](../../mobile/src/lib/chat-wire.ts) contains JSON text protected by the live transport connection. Storing it with a third party requires an independently encrypted and authenticated envelope. Bob must be able to verify Alice as the sender even when he retrieves the message through a connection to a mailbox.

The [registry reader](../../mobile/src/lib/registry-core.ts) resolves one device key per account today — the blocker the locked multi-device auth model replaces (hard-cut). Mailbox locations and prekey bundles are not part of it and remain non-goals for this slice. The [identity package](../../packages/identity/README.md) can derive X25519 public keys; session setup and message encryption for third-party stores would need additional work and are out of MVP scope.

minip2p supports custom authenticated streams, pubsub discovery, mDNS, and Circuit Relay v2. Discovery uses presence beacons. The examined React Native interface has no DHT record API, so QOP would need to integrate one. Its mobile lifecycle binding reduces background activity within the execution time allowed by the OS. [1](https://minip2p.com/reference/feature-matrix/) [2](https://minip2p.com/typescript/lifecycle/)

## Alternative architectures and comparison (fallback only)

> Retained for research context. **Not** the MVP implementation path. Prefer the locked always-on CLI + on-chain multi-device keys direction above.

Complexity estimates are relative to the current codebase. Third-party storage needs asynchronous encryption and delivery that survives crashes, in addition to the storage work listed below.

| Option | Holds messages after Alice disconnects? | Who chooses storage? | Added complexity | Main limitation |
| --- | --- | --- | --- | --- |
| Linked devices with replicated outbox | Yes, after another own device accepts | Account owner | High, requires device authorization and sync | A holder must overlap a reachable recipient device |
| Local outbox and direct retry | No external copy | Alice's device | Low | Requires later online overlap |
| Recipient-selected mailbox | Yes, after acceptance | Bob | Moderate | Selected provider can fail |
| Multiple recipient mailboxes | Yes, according to accepted replicas | Bob; Alice uploads copies | Moderate to high | Fixed replicas need repair or replacement |
| Sender-owned outbound mailbox | Yes, while it retries or serves messages | Alice | Moderate to high | Requires forwarding or a known pull route |
| DHT discovery plus mailboxes | Yes, because of mailbox storage | Bob, discovered through DHT | High | DHT freshness and storage remain separate |
| Direct DHT envelope storage | Conditional on the actual storage policy | DHT placement | High to very high | Churn, expiry, abuse, and inbox completeness |
| Assigned replicated storage network | Yes, within its retention/failure policy | Network membership and placement rules | Very high if built for QOP | QOP must build or adopt storage-network operations |
| Friend/device history replication | Yes, if another holder received it | Participants or trusted helpers | High if adopting full history sync | A holder with the message must be reachable |
| Federated messaging backend | Yes, under server policies | Account homeservers | High architectural change | Larger change to QOP's messaging model |

The options can combine. Multiple mailboxes can use a DHT directory, and a personal mailbox can handle both incoming and outgoing messages.

### Recipient-selected, self-hostable mailboxes

Bob creates an inbox and shares authenticated deposit details with Alice. Alice saves her message locally, tries direct delivery, and uploads to the inbox if needed. Bob later retrieves, verifies, decrypts, and saves it before acknowledging. The server deletes acknowledged or expired items under its retention policy.

Briar Mailbox implements the personal always-on helper. It receives encrypted messages while Briar is offline and delivers messages to contacts when they return. Users link a spare Android device by QR code and leave it on power and Wi-Fi. Briar also documents a Linux x86_64 command-line build. [3](https://briarproject.org/download-briar-mailbox/)

SimpleX uses separate one-way queues with random sender and receiver identifiers. Queue credentials separate deposit permission from retrieval permission. The protocol supports acknowledgment and expiration; server configuration controls retention. Users can choose default or self-hosted receiving servers and move existing contacts through a receiving-address change. [4](https://github.com/simplex-chat/simplexmq/blob/stable/protocol/simplex-messaging.md) [5](https://github.com/simplex-chat/simplex-chat/blob/stable/docs/SERVER.md)

A QOP mailbox could run a storage protocol on a minip2p peer with its own identity. It must not hold Bob's private identity key. Shared hosts need to isolate users' queues and limit disk use. A process could also run a connectivity relay, with separate handling for stored messages.

One default host simplifies deployment. Users relying only on it lose offline delivery during its outage, even if the software supports self-hosting elsewhere.

### Multiple independent mailboxes

Bob advertises a small list of authorized stores. Alice uploads copies and tracks which stores accept them. Bob fetches from those stores and removes duplicates. The servers need not coordinate when clients perform the replication.

Nostr NIP-17 defines a signed list of preferred DM relays and recommends one to three. NIP-01 defines relay acceptance responses, which are distinct from recipient delivery. NIP-17 remains a draft. [6](https://github.com/nostr-protocol/nips/blob/master/17.md) [7](https://github.com/nostr-protocol/nips/blob/master/01.md)

Replicas help when they hold the message and can fail independently. Two addresses sharing one database offer little protection against database failure. Additional copies also cost bandwidth and expose routing metadata to more operators.

If one copy disappears after Alice disconnects, a surviving service needs authority to create a replacement. Otherwise redundancy stays reduced until an endpoint returns. A managed storage network can handle this repair automatically.

### Sender-owned outbound mailboxes

If Bob and all his mailboxes are unreachable or full, Alice's own always-on service can save the encrypted message and keep trying after she closes QOP. SMTP specifies this kind of queue-and-retry responsibility. [8](https://datatracker.ietf.org/doc/html/rfc5321#section-4.5.4.1)

Alice's service can forward to Bob's stores, or Bob can fetch from Alice's service. For fetching to work, Bob must know or securely discover its address.

A forwarding service needs retry deadlines, deposit permission, authenticated address updates, and a return route for receipts. Without message keys, it cannot re-encrypt for a replacement recipient key. Using the same provider for both sides also leaves them exposed to its outage.

An outbound service is useful when recipient stores may be unavailable longer than Alice remains online. Recipient replication may already cover enough failures to make it unnecessary.

### DHT discovery plus mailboxes

A DHT can map Bob's identity or a private lookup key to a signed record listing his mailbox peer IDs and addresses. That record is the mailbox descriptor. The mailboxes hold the messages; the DHT helps Alice find them.

A descriptor needs a signer, version, expiry, and validation rules. A valid signature can still belong to an outdated record. Clients can reject versions older than ones they have seen, but new installations need another way to judge freshness.

Contacts can exchange descriptors through authenticated messages or invites. Sending by handle alone requires a lookup service. QOP's on-chain registry can authenticate the signer but does not currently publish mailbox details. Signed off-chain records could carry addresses and key material, with a defined publication and recovery path.

A DHT directory is useful when addresses must remain discoverable without one operator. It still needs bootstrap peers, record refresh, stale-record handling, and mobile lookup support. Finding a replacement mailbox cannot recover messages stored only on a failed one.

### Direct DHT storage

Alice stores encrypted messages on nodes selected by the DHT. Bob later queries those nodes. The design must set record expiry and specify how copies survive restarts and changes in which nodes are online.

Automatic placement removes the need for users to choose providers. Independently operated nodes can contribute to one network that handles both lookup and storage. A DHT can also replace unreachable routing peers, though repairing the messages those peers held requires storage-specific behavior.

BitTorrent BEP 44 supports signed mutable values and immutable values. Nodes may reject encoded values over 1,000 bytes. Values may expire after two hours without re-announcement; hourly refresh is recommended, and another node can refresh an already signed record. Longer offline delivery therefore needs someone to keep refreshing copies. [9](https://bittorrent.org/beps/bep_0044.html)

OpenDHT supports distributed values, listeners, signing, encryption, and proxies. Its defaults allow values up to 64 KiB and expire them after ten minutes; custom deployments can use different policies. Jami documents its standalone DHT node as using bounded, nonpersistent memory. A longer expiry alone would not make its records survive restarts. [10](https://github.com/savoirfairelinux/opendht) [11](https://github.com/savoirfairelinux/opendht/blob/master/include/opendht/value.h) [12](https://docs.jami.net/user/jami-distributed-network.html)

Bob must discover every pending message, including IDs he does not know yet. A mailbox key containing multiple values needs pagination and deposit limits. A mutable index must handle concurrent writers. Per-sender sequence slots require known senders and a policy for gaps. The chosen DHT must retrieve the full inbox while nodes come and go and senders write concurrently.

Replication must continue while both phones are absent. If only Alice can refresh or replace copies, delivery depends on her return. If storage nodes do it, their membership and repair rules become part of QOP's delivery design.

### Assigned replicated storage networks

Session's swarm design copies records to joining nodes and redistributes them when a swarm dissolves. Its desktop development documentation specifies fourteen-day retention for ordinary direct messages and separate polling cursors for each node. [13](https://docs.getsession.org/session-network/session-nodes/swarms) [14](https://github.com/session-foundation/session-desktop/blob/dev/ARCHITECTURE.md)

Session's storage-server source documents forwarding to swarm members, signed responses, authenticated paginated retrieval, and message-size limits. Its node participation model includes economic incentives. The repair design can inform QOP independently of Session's token or encryption choices. [15](https://github.com/session-foundation/session-storage-server/blob/77a2687e1033a7fc37e46f851c5aed70bbee4c49/oxenss/rpc/client_rpc_endpoints.h) [16](https://token.getsession.org/staking)

This approach suits requirements for automatic repair and operator replacement. Building it adds node admission, placement, failure detection, repair traffic, quotas, upgrades, and operator funding. Reusing an existing network requires checking its support for third-party traffic and QOP's protocol needs.

### Participant replication, federation, and other candidates

Jami stores conversation history in synchronized Git repositories on participant devices. Peers announce commits and fetch history from holders; the DHT helps with invitations and mobile wakeups. A group member or linked device can supply a copy it already received. In a two-person chat, however, Bob still needs access to a holder after Alice disconnects. The public DHT does not establish a durable copy of that history. [17](https://docs.jami.net/developer/jami-concepts/swarm.html)

Scuttlebutt replicates histories through friends and public peers called pubs. A recipient can catch up from a peer that copied the relevant feed. Adopting full history replication would expand QOP's storage, deletion, and sync work. A helper holding only pending ciphertext could provide a smaller feature. [18](https://handbook.scuttlebutt.nz/concepts/pub.html) [19](https://handbook.scuttlebutt.nz/concepts/gossip)

XMPP specifies recipient-server offline storage and errors when storage is unavailable. Matrix replicates persistent room data across homeservers. Either could supply a messaging backend, with a larger change to QOP's current direct-peer design. [20](https://xmpp.org/extensions/xep-0160.html) [21](https://spec.matrix.org/latest/server-server-api/)

Other candidates address parts of the problem:

| Technology | Relevant capability | What QOP still needs |
| --- | --- | --- |
| IPFS | Content discovery and verifiable blob transfer | Explicit pinning, inbox discovery, retention, authorization |
| Waku | Store history retrieval and lightweight publishing | Application encryption, retention, and delivery rules |
| Veilid | DHT values, watches, and privacy-oriented routing | Retention, complete inbox retrieval, mobile integration, remote acceptance |
| Tox | DHT-based peer discovery | Its offline-messaging note distinguishes queued delivery from fully asynchronous storage |
| Circuit Relay / iroh relays | Connectivity through intermediaries | Persistent message storage and retrieval |

IPFS needs a node to retain or pin the ciphertext. A content identifier cannot retrieve bytes that every provider has discarded. It could carry attachments, while a separate inbox tells Bob which files to fetch. [22](https://docs.ipfs.tech/concepts/persistence/)

Waku's FAQ says message availability is not guaranteed and payload E2EE is not provided by default. Its reliability design suggests checking independent stores and retrying, while leaving endpoint delivery to the application. The repository containing that design was archived on June 5, 2026, so maintained integration options need a separate check. [23](https://docs.waku.org/learn/faq) [24](https://github.com/logos-messaging/specs/blob/master/standards/application/p2p-reliability.md)

Veilid 0.5.7 can defer DHT writes when offline or unable to reach enough peers, and provides a separate flush operation. A successful write call may therefore precede remote storage. Deleting a record removes the local copy and stops its refresh; it does not delete every network copy. The examined API gives no long-term retention guarantee. [25](https://docs.rs/veilid-core/0.5.7/veilid_core/struct.RoutingContext.html)

Tox's offline-messaging note distinguishes waiting for simultaneous connectivity from storing on another node. Circuit Relay requires a connected destination, and iroh describes its relays as stateless packet forwarders. These connectivity mechanisms need an additional storage service for offline delivery. [26](https://wiki.tox.chat/users/offline_messaging) [27](https://libp2p.io/docs/circuit-relay/) [28](https://docs.iroh.computer/about/faq)

## Requirements across the candidates

Apply each requirement to its device role. Full linked endpoints use authenticated live sessions and private local storage. Public ciphertext stores additionally need offline envelope preparation, deposit admission, and retrieval protocols. The storage-specific requirements below do not all belong in the first linked-device prototype.

### Encryption and offline first contact

For pre-encryption while Bob is offline, Alice needs authenticated recipient key material without an existing session. A full linked device that waits for a live handshake does not require offline session setup. Bob can publish it beforehand or include it in an invite. Signal's PQXDH uses signed and one-time prekeys and defines handling for delayed messages. QOP still needs a reviewed implementation that fits its platforms. [29](https://signal.org/docs/specifications/pqxdh/)

Replicated prekeys need an issuance policy. Two readers can retrieve the same supposedly one-time key from different DHT replicas. A designated distributor, separate key pools per distributor, or a protocol that safely handles reuse could address this.

Libsodium sealed boxes encrypt to a recipient key without authenticating the sender. Later compromise of that recipient key can expose captured ciphertext despite the ephemeral sender key. QOP would need additional protocol support for sender authentication and forward secrecy. [30](https://doc.libsodium.org/public-key_cryptography/sealed_boxes)

Signal's Double Ratchet handles reordered messages with skipped message keys and bounds such as `MAX_SKIP`. QOP's maximum backlog and allowed reordering must fit those limits. [31](https://signal.org/docs/specifications/doubleratchet/)

Retained ciphertext is useful only while Bob has the keys needed to decrypt it. Message retention must align with old-prekey and session-state retention.

### Durable acknowledgments and retries for storage services

The proposed internal states are:

| State | Evidence |
| --- | --- |
| Queued locally | Message and necessary encryption state are durably saved on Alice's device |
| Accepted for forwarding | Alice's outbound service accepted retry responsibility, if used |
| Stored for recipient | Enough recipient stores confirm they saved the message under the chosen replication policy |
| Delivered | An authenticated recipient device confirms it saved the message |
| Read | The recipient reports opening the message, if read receipts are enabled |

The UI can combine states, but storage acceptance must remain distinct from recipient delivery. Current QOP `sent` follows a recipient acknowledgment, so adding a storage state requires an explicit UI change.

Allow retries and process each message once. Alice must save the encrypted envelope and updated session state before transmitting, then resend that envelope on retry. Bob must save the message, session changes, duplicate record, and pending receipt in a crash-safe way. Losing a message after consuming its decryption key would make a retry useless.

Match duplicates to the authenticated sender, device, and message context. An attacker-chosen UUID must not suppress another sender's message. Delivery receipts must also authenticate the recipient device and identify the original message.

Multiple paths produce intentional copies of the same message, not a higher probability of random UUID collision. The receiver must recognize those copies, display the message once, and resend a receipt when needed.

If a store deletes on acknowledgment, Bob must save the message before acknowledging. A DHT store can instead keep ciphertext until expiry. Lost acknowledgments may cause repeat downloads; lost delivery receipts must be recoverable and deliverable while Alice is offline. Retries need distinct handling for network failures, full queues, expiry, revoked permission, and decryption failures.

```mermaid
sequenceDiagram
    participant A as Alice's phone
    participant M as Bob's mailbox
    participant B as Bob's phone
    participant R as Alice's mailbox
    A->>A: Save envelope and session state
    A->>M: Deposit encrypted envelope
    M->>M: Persist under retention policy
    M-->>A: Storage acceptance and expiry
    Note over A,B: Alice disconnects; Bob later returns
    B->>M: Fetch pending envelopes
    M-->>B: Envelopes and pagination cursor
    B->>B: Verify, decrypt, save, queue receipt
    B->>M: Acknowledge persisted envelopes
    B->>R: Deposit authenticated delivery receipt
    Note over A,R: Alice retrieves receipt when she returns
```

Direct delivery would use the same logical IDs and recipient receipts. QOP could briefly try it before uploading to storage, or race both paths. Mobile measurements should set the delay so an offline contact does not cause a long wait on every send.

### Mobile wakeup

Apple does not guarantee background notifications. Android Doze suspends ordinary network access and defers background work. FCM high-priority delivery grants limited processing time for user-visible notifications; repeated invisible use can lead to deprioritization. Phones cannot rely on continuously running a peer socket or DHT loop. [32](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app) [33](https://developer.android.com/training/monitoring-device-state/doze-standby) [34](https://firebase.google.com/docs/cloud-messaging/android-message-priority)

Push can trigger retrieval or show a generic alert. QOP should also reconcile with reachable holders whenever it opens, including when no push arrived or notifications are disabled. A disconnected phone retrieves messages after connectivity returns.

APNs credentials belong to the distributed app and must remain private. For the stock iOS app, a likely design is a restricted QOP push gateway that authorized delivery holders or mailbox operators can call. An independently signed app can use its own credentials. This gateway is a design inference from Apple's credential requirements; it need not store messages or receive plaintext. [35](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)

Keep push tokens private and limit who can trigger notifications. A gateway outage should delay alerts while messages remain available on app open.

### Abuse, metadata, and storage admission

Public stores need limits on message size, queue bytes, total storage, request rate, and retention. Per-contact deposit credentials let Bob block one abusive sender. Unknown senders need a separately limited introduction queue before they receive contact credentials.

DHTs also need defenses against an attacker creating many nodes to control placement or hide records. Signatures reject forged data but cannot force a holder to return it. libp2p documents attacks on cooperative routing. QOP needs a node-admission policy; having on-chain user identities does not automatically protect storage-node membership. [36](https://docs.libp2p.io/concepts/security/security-considerations/)

Storage operators and network observers may still see connection addresses, lookup keys, sizes, and timing. Hashing a public QOP ID leaves its mailbox discoverable to anyone who computes the same hash. IPFS documents this exposure in its public routing. Private lookup keys, padding, proxies, or different outer envelopes per provider can reduce specific leaks. [37](https://docs.ipfs.tech/concepts/privacy-and-encryption/)

A malicious holder can keep ciphertext after deletion or expiry. Key erasure and forward secrecy can limit later exposure, but cannot force that holder to remove its copy.

### Migration, devices, ordering, and attachments

Migration needs a tested new destination, a signed address update, and an overlap period before retiring the old store. Recovery must also work if the old store is already down. SimpleX's receiving-address change currently requires its old server to be online. A DHT can publish a replacement address once Bob authorizes it, but cannot supply that authorization for him. [38](https://simplex.chat/faq/)

Multiple-device support adds authenticated device lists, separate encryption sessions, and a definition of delivered: one device or every target device. One device's acknowledgment must not delete another's only pending copy. Signal's Sesame describes these session-management issues under delayed, duplicated, reordered, or lost delivery. [39](https://signal.org/docs/specifications/sesame/)

Revocation cannot retract keys or plaintext a device already has. Offline senders may use stale device records. QOP needs rules for record freshness, messages encrypted before rotation, retained old keys, and visible key-change errors.

QOP displays messages in local arrival order. Backlogs from different stores may arrive out of order, so a future display policy could use authenticated sender sequences and reply references. It must tolerate clock differences and missing messages.

Attachments need their own encryption, integrity checks, quotas, resumable transfers, and retention. File references and keys belong inside the authenticated message. Retention must keep the file available long enough for Bob to fetch it. A temporary mailbox also needs to remain distinct from history sync and account backup.

## Operational scale and relative effort

For an illustrative capacity estimate, assume 10,000 users send 50 messages daily, each encrypted envelope uses 2 KiB, and three copies remain for fourteen days.

| Assumption | Calculation | Payload storage |
| --- | --- | --- |
| Every message retained for the full window | 10,000 × 50 × 2 KiB × 3 × 14 | About 40.1 GiB |
| Only 10% need that full-window storage | Previous result × 0.10 | About 4.0 GiB |

The second case counts only messages retained for the full window. Both omit indexes, logs, backups, extra padding, repair traffic, abuse, and attachments. Groups and multiple devices add copies. Deleting after acknowledgment reduces average storage.

Hosting cost depends on bandwidth, regions, retention, and service commitments. Implementation time also depends on the encryption library and mobile support. Client replication adds protocol work; DHT integration adds discovery and hostile-node handling; a custom storage network adds ongoing repair and membership operations. Direct delivery reduces storage traffic but leaves this work in place.

## How to compare the candidates

Set the service promise before comparing implementations. For linked devices, specify how long holders retain pending sends and how long devices may miss synchronization. Fourteen days would be one experimental retention target. Compare seven- and thirty-day windows before choosing a product limit.

### Decisions before implementation

| Decision | What needs an answer |
| --- | --- |
| QOP outage | Must live conversations, self-hosted offline delivery, and default users' offline delivery each continue? Which discovery, relay, and registry-access dependencies remain? |
| Live delivery | Does a recipient acknowledgment skip mailbox upload? How long may an unconnected send try direct delivery? |
| First contact | Must an unknown sender be able to send by handle while the recipient is offline, or can an invite supply keys and mailbox details? |
| Retention | How long must messages, attachments, receipts, and the keys needed to read them remain available? |
| Device support | The linked-device candidate requires multiple devices. Is acceptance by any authorized recipient device sufficient, and how do its other devices catch up? |
| Notifications | Is retrieval on app open sufficient initially, or are timely background alerts required? |

Self-hosting gives users an alternative provider, but it does not by itself guarantee permissionless participation or independence for default users. These requirements need separate answers.

### Implementation gates for the alternative storage candidates

An automatic local outbox improves the existing direct path without committing to a storage architecture. Before sending private messages to any third-party store, QOP needs independently authenticated encryption, a first-contact key-distribution policy, and persistence that keeps message and encryption state consistent across crashes.

Define queued, stored, and delivered states before connecting storage acceptance to the UI. Prove that Bob can persist and acknowledge a message, then deliver the receipt after Alice reconnects. A lost acknowledgment must cause a harmless retry rather than premature deletion or an undecryptable message.

Use comparable logical message identities, delivery outcomes, and recipient receipts across candidates. Full endpoints can perform live encryption; ciphertext stores require a portable encrypted envelope. Compare admission, remote persistence, expiry, complete retrieval, quotas, and duplicates. Mailboxes may offer paginated fetch and deletion on acknowledgment; DHT stores may use other retrieval methods and expiry alone. Judge whether each delivers the required messages.

Test the candidates against the same failures:

| Candidate | Purpose |
| --- | --- |
| Linked phone and CLI with replicated outbox | Test durable handoff, independent sessions, and eventual receipt synchronization |
| Self-hostable mailbox with a QOP default and two independent test operators | Test delivery when chosen providers fail |
| Direct DHT storage with a specified implementation and persistence policy | Test retention and retrieval while phones are offline and storage nodes leave |
| DHT directory with mailbox storage | Measure distributed discovery separately from message storage |
| Assigned storage swarm | Test automatic placement and repair, and measure their cost |

Name the DHT implementation and persistence policy being tested. Kademlia specifies a lookup approach, not a complete storage service. Include any always-on refresher in the cost and failure model.

Mailboxes give users a choice of operator and let each operator set explicit storage terms. A default-only setup depends on that provider; replicas can reduce that dependence. An outbound mailbox adds retrying while Alice is offline and Bob's stores are unavailable.

A replicated network can handle node replacement for users. Direct DHT storage is viable if it meets the same retention and retrieval requirements. A DHT directory helps when distributed discovery or address recovery matters. Which benefit deserves the added work remains a product decision.

### Further comparison experiments

| Experiment | What must be demonstrated |
| --- | --- |
| Disconnect Alice immediately after acceptance; reconnect only Bob later | Retrieval within the accepted retention period without sender participation |
| Restart a storage process after acceptance | Promised durable messages survive |
| Deliver over an existing verified connection with the mailbox unavailable | Live chat completes with a recipient receipt and no mailbox upload |
| Compare direct probing with immediate mailbox upload on real phones | Measure connection success, time to delivery, traffic, and battery use in foreground and background states |
| Deliver directly but lose its acknowledgment, then upload the fallback copy | Bob displays one message and Alice eventually receives an authenticated receipt |
| Remove a storage node while both phones remain offline | Remaining replicas preserve delivery; any claimed repair occurs without phones |
| Take down QOP-operated services | Record which discovery, delivery, and notification functions still work |
| Fail every advertised recipient store before upload | An outbound service accepts and retries if supported; otherwise the message stays queued locally |
| Concurrent senders, duplicates, missing items, reordered pages | Complete retrieval and single presentation without trusting timestamps |
| Crash between decrypt, save, receipt creation, and acknowledgment | Messages remain decryptable after retry, and stores do not delete unsaved messages |
| Reuse or exhaust prekeys; rotate recipient keys during delay | Defined, secure first-contact and recovery behavior |
| Flood introduction queues or fill storage | Bounded resource use and explicit rejections |
| Expire descriptors, messages, and attachments at different times | Defined refresh and expiry behavior without misleading delivery claims |
| Suspend real iOS/Android devices; disable push | Eventual retrieval on app open; separately measure alert latency |
| Migrate with the previous provider unavailable; reinstall a client | Authenticated location recovery with stated freshness limitations |

Measure missing messages, acceptance and delivery latency, complete-backlog retrieval, traffic, repair cost, and battery use. Record the tested failures and verify retrieval separately from upload acknowledgment.

## Locked vs open decisions

**Locked (2026-09-11):**

| Item | Decision |
| --- | --- |
| MVP promise | Always-on CLI holds Alice’s pending sends; phone-only unchanged |
| Auth model | On-chain multi-device keys (`addDevice` / `removeDevice`); not `rotateDevice` as the multi-device path |
| Breaking changes | Hard-cut OK; no soft migration / dual-read of single `deviceKey` |
| Owner recovery after compromise | Wipe all devices / re-add |
| Live revocation on existing connections | Must-have for MVP; not next-connect-only; **60s** max auth age **implemented**; finality/RPC values remain proposal |
| Non-goals this slice | Default hosted mailbox; app E2EE/PQXDH as MVP deps; expanding from comparison sections |

**Still open / proposal:**

| Item | Status |
| --- | --- |
| Live revoke on existing connections | **LOCKED** (must-have); on resume invalidate cached auth; **60s** max auth age **implemented**; finality / RPC-failure behavior still **proposal** (monotonic elapsed time while running) |
| Contact/`keyChanged` tightenings, device cap details | Proposal defaults in Project decisions sheet / auth plan |
| Preserve history on device remove | Strong proposal (treat as requirement unless overridden) |
| Auth before phone↔CLI outbox sync | **Recommended sequencing — not locked** |
| Phone↔CLI sync contract | Open (handoff transport, schema, ack/conflict/completion) |
| Offline retention window, attachments, notifications, Bob multi-device | Deferred / later |

The sources do not settle QOP's actual node availability, operator diversity, encryption library, SDK compatibility, or delivery targets for the comparison architectures. Prototype results are needed before revisiting mailbox/DHT as product options.

## Sources

Numbered links in the text identify the supporting source. Living pages and moving branches were accessed September 10, 2026; an access date is not a publication date.

1. minip2p. [Feature matrix](https://minip2p.com/reference/feature-matrix/). Updated September 9, 2026. Transport, discovery, and SDK capabilities.
2. minip2p. [Endpoint lifecycle](https://minip2p.com/typescript/lifecycle/). Updated September 9, 2026. Mobile activity binding and endpoint ownership.
3. Briar Project. [Download Briar Mailbox](https://briarproject.org/download-briar-mailbox/). Living documentation. Personal encrypted mailbox deployment.
4. SimpleX. [SimpleX Messaging Protocol](https://github.com/simplex-chat/simplexmq/blob/stable/protocol/simplex-messaging.md). Moving `stable` branch. Queue authorization, acknowledgment, and retention.
5. SimpleX. [Server operations](https://github.com/simplex-chat/simplex-chat/blob/stable/docs/SERVER.md). Moving `stable` branch. Default/custom servers and configuration.
6. Nostr contributors. [NIP-17: Private Direct Messages](https://github.com/nostr-protocol/nips/blob/master/17.md). Draft, moving branch. Recipient relay lists.
7. Nostr contributors. [NIP-01: Basic protocol flow description](https://github.com/nostr-protocol/nips/blob/master/01.md). Moving branch. Relay acceptance and rejection.
8. John Klensin / IETF. [RFC 5321, section 4.5.4.1](https://datatracker.ietf.org/doc/html/rfc5321#section-4.5.4.1). October 2008. Queued retry precedent.
9. Arvid Norberg and Steven Siloti / BitTorrent. [BEP 44: Storing arbitrary data in the DHT](https://bittorrent.org/beps/bep_0044.html). Draft; created December 19, 2014, last modified February 1, 2017. Value size and republication policy.
10. Savoir-faire Linux. [OpenDHT](https://github.com/savoirfairelinux/opendht). Moving repository. Distributed value store capabilities.
11. Savoir-faire Linux. [OpenDHT value.h](https://github.com/savoirfairelinux/opendht/blob/master/include/opendht/value.h). Moving `master` branch. Value-size and expiration defaults.
12. Jami. [Jami distributed network](https://docs.jami.net/user/jami-distributed-network.html). Living documentation. Standalone node persistence and storage limits.
13. Session. [Swarms](https://docs.getsession.org/session-network/session-nodes/swarms). Living documentation. Replication and membership repair.
14. Session Foundation. [Session desktop architecture](https://github.com/session-foundation/session-desktop/blob/dev/ARCHITECTURE.md). Development branch. Namespace TTLs and polling.
15. Session Foundation. [Storage server RPC endpoints](https://github.com/session-foundation/session-storage-server/blob/77a2687e1033a7fc37e46f851c5aed70bbee4c49/oxenss/rpc/client_rpc_endpoints.h). Pinned commit `77a2687e1033a7fc37e46f851c5aed70bbee4c49`. Replication responses and retrieval protocol.
16. Session. [Staking](https://token.getsession.org/staking). Living documentation. Storage-network participation model.
17. Jami. [Swarm](https://docs.jami.net/developer/jami-concepts/swarm.html). Living design documentation with historical sections. Participant history synchronization.
18. Scuttlebutt. [Public peers, aka pubs](https://handbook.scuttlebutt.nz/concepts/pub.html). Undated handbook. Public replication peers.
19. Scuttlebutt. [Gossip](https://handbook.scuttlebutt.nz/concepts/gossip). Undated handbook. Feed synchronization.
20. Peter Saint-Andre / XMPP Standards Foundation. [XEP-0160: Best Practices for Handling Offline Messages](https://xmpp.org/extensions/xep-0160.html). Version 1.0.1, October 7, 2016. Offline storage behavior.
21. Matrix.org Foundation. [Server-Server API](https://spec.matrix.org/latest/server-server-api/). Current stable specification endpoint. Persistent federated room data.
22. IPFS. [Persistence, permanence, and pinning](https://docs.ipfs.tech/concepts/persistence/). Living documentation. External retention obligations.
23. Waku. [FAQ](https://docs.waku.org/learn/faq). Living documentation. Availability and payload-encryption limitations.
24. Hanno Cornelius and contributors. [Waku P2P Reliability](https://github.com/logos-messaging/specs/blob/master/standards/application/p2p-reliability.md). Repository archived June 5, 2026. Reliability-layer distinctions.
25. Veilid. [RoutingContext API](https://docs.rs/veilid-core/0.5.7/veilid_core/struct.RoutingContext.html). Version 0.5.7. Deferred writes, flush, and local deletion semantics.
26. Tox. [Offline messaging](https://wiki.tox.chat/users/offline_messaging). Undated wiki with historical proposals. Queue versus asynchronous delivery distinction.
27. libp2p. [Circuit Relay](https://libp2p.io/docs/circuit-relay/). Living documentation. Live relayed connectivity.
28. iroh. [FAQ](https://docs.iroh.computer/about/faq). Living documentation. Stateless relays.
29. Ehren Kret and Rolfe Schmidt / Signal. [PQXDH](https://signal.org/docs/specifications/pqxdh/). Revision 3, updated January 23, 2024. Asynchronous authenticated key agreement and prekey handling.
30. Libsodium. [Sealed boxes](https://doc.libsodium.org/public-key_cryptography/sealed_boxes). Living documentation. Anonymous sender encryption and security scope.
31. Trevor Perrin, Moxie Marlinspike, and Rolfe Schmidt / Signal. [Double Ratchet](https://signal.org/docs/specifications/doubleratchet/). Revision 4, November 4, 2025. Out-of-order messages and bounded skipped keys.
32. Apple. [Pushing background updates to your app](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app). Living documentation. Background notification limitations.
33. Android Developers. [Optimize for Doze and App Standby](https://developer.android.com/training/monitoring-device-state/doze-standby). Living documentation. Background network restrictions.
34. Firebase. [Android message priority](https://firebase.google.com/docs/cloud-messaging/android-message-priority). Living documentation. FCM processing and deprioritization.
35. Apple. [Establishing a token-based connection to APNs](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns). Living documentation. Provider credentials.
36. libp2p. [Security considerations](https://docs.libp2p.io/concepts/security/security-considerations/). Living documentation. Cooperative routing and malicious peers.
37. IPFS. [Privacy and encryption](https://docs.ipfs.tech/concepts/privacy-and-encryption/). Living documentation. Public routing metadata.
38. SimpleX. [Frequently asked questions](https://simplex.chat/faq/). Living documentation. Receiving-address migration dependency.
39. Moxie Marlinspike and Trevor Perrin / Signal. [Sesame](https://signal.org/docs/specifications/sesame/). Revision 2, April 14, 2017. Asynchronous multiple-device session management.

40. Jami. [Synchronization protocol](https://docs.jami.net/developer/jami-concepts/synchronization-protocol.html). Living design with draft wording and implementation reference. Accessed September 11, 2026. Announcement-triggered device synchronization.
41. minip2p. [TypeScript API](https://minip2p.com/reference/typescript-api/). Accessed September 11, 2026; checked against installed 0.5.3. Discovery events and subscriptions.
42. minip2p. [Discover peers](https://minip2p.com/rust/discover-peers/). Accessed September 11, 2026. Signed beacons, mesh dependency, and expiring peer records.
43. minip2p. [Networking and events](https://minip2p.com/typescript/networking-and-events/). Accessed September 11, 2026. Relay events and discovery are separate mechanisms.
