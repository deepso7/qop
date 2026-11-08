//! Pairing: the `qop-pair1.` offer and the `/qop/pair/1` session behind it
//! (`cli/src/pairing-link.ts`, `pairing-session.ts`).
//!
//! The phone dials the offer and sends `hello` (proving it scanned the code), then `approval`
//! (the owner-signed add-device record), each on its own stream: one frame in, one frame out.
//! [`PairingSession`] holds the rules and is pure; [`serve`] does the IO for one stream.
//!
//! Rules: the first phone whose hello passes claims the session; it must be an active device of
//! the offered account in a fresh read. An approval is checked against that read (owner
//! signature, account, key, nonce, deadline) and persisted *before* `approvalSaved` goes out.
//! The same record again replays `approvalSaved` without the nonce/deadline checks (the phone
//! lost the first reply); a different one while ours is pending gets `approvalConflict`.

use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alloy_primitives::{Address, B256, U256};

use super::enrollment;
use super::{Api, Chain};
use crate::keys::random_32;
use crate::node::Stream;
use crate::store::{Identity, Store, StoreError};
use crate::wire::pairing::{
    DEVICE_ACTION_DEADLINE_SECONDS, PAIRING_MAX_ADDRESSES, PAIRING_TTL_SECONDS,
};
use crate::wire::{
    ApprovalOperation, DeviceActionApproval, PAIRING_FRAME_MAX_BYTES, PairingError, PairingFrame,
    PairingOffer, device_key_from_peer_id,
};

/// The account as one fresh chain read saw it, with that block's time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountSnapshot {
    pub chain_id: U256,
    pub chain_time: u64,
    pub devices: Vec<B256>,
    pub nonce: U256,
    pub owner: Address,
    pub qid: U256,
    pub registry: Address,
}

/// Why a frame was refused (`PairingSessionError`); the stream is reset.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rejected {
    /// Another phone already claimed this offer.
    Claimed,
    /// The offer expired or was replaced.
    Expired,
    /// The phone is not an active device of the account.
    Membership,
    /// Wrong session, account, key, nonce, deadline, digest or signer.
    Mismatch,
    /// The phone does not know the offer's secret.
    Secret,
    /// An approval before any hello.
    Unclaimed,
}

/// The reply to an approval frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ack {
    Saved(B256),
    Conflict(B256),
}

/// An accepted approval: the reply, and whether the record must be persisted before it is sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settled {
    pub ack: Ack,
    pub save: bool,
}

/// One offer's session; regenerate replaces it (and [`retire`](Self::retire)s the old one).
#[derive(Debug)]
pub struct PairingSession {
    offer: PairingOffer,
    /// The phone that passed hello first: its peer ID and device key.
    claim: Option<(String, B256)>,
    retired: bool,
}

impl PairingSession {
    pub fn new(offer: PairingOffer) -> PairingSession {
        PairingSession {
            offer,
            claim: None,
            retired: false,
        }
    }

    pub fn offer(&self) -> &PairingOffer {
        &self.offer
    }

    pub fn is_claimed(&self) -> bool {
        self.claim.is_some()
    }

    /// A replaced offer accepts no new hello and no new approval (replays still settle).
    pub fn retire(&mut self) {
        self.retired = true;
    }

    fn fresh(&self, now: u64) -> Result<(), Rejected> {
        if self.retired || self.offer.expires_at <= now {
            Err(Rejected::Expired)
        } else {
            Ok(())
        }
    }

    /// Checks a hello from `peer` (whose device key is `phone_key`) and claims the session.
    pub fn hello(
        &mut self,
        peer: &str,
        phone_key: B256,
        snapshot: &AccountSnapshot,
        hello: (B256, B256, B256),
        now: u64,
    ) -> Result<PairingFrame, Rejected> {
        let (challenge, secret, session_id) = hello;
        self.fresh(now)?;
        if secret != self.offer.secret {
            return Err(Rejected::Secret);
        }
        if session_id != self.offer.session_id
            || snapshot.chain_id != self.offer.chain_id
            || snapshot.registry != self.offer.registry
            || snapshot.qid != self.offer.qid
        {
            return Err(Rejected::Mismatch);
        }
        if !snapshot.devices.contains(&phone_key) {
            return Err(Rejected::Membership);
        }
        if self
            .claim
            .as_ref()
            .is_some_and(|(claimed, _)| claimed != peer)
        {
            return Err(Rejected::Claimed);
        }
        self.claim = Some((peer.to_owned(), phone_key));
        Ok(PairingFrame::HelloAck {
            chain_id: self.offer.chain_id,
            challenge,
            device_key: self.offer.device_key,
            qid: self.offer.qid,
            registry: self.offer.registry,
            session_id: self.offer.session_id,
        })
    }

    /// Checks an approval against the fresh `snapshot` and the `pending` approval (already
    /// filtered by [`enrollment::load_occupying`]). Persist when `save` before replying.
    pub fn approval(
        &self,
        peer: &str,
        record: &DeviceActionApproval,
        snapshot: &AccountSnapshot,
        session_id: B256,
        pending: Option<&DeviceActionApproval>,
        now: u64,
    ) -> Result<Settled, Rejected> {
        let (claimed, phone_key) = self.claim.as_ref().ok_or(Rejected::Unclaimed)?;
        if claimed != peer {
            return Err(Rejected::Claimed);
        }
        if session_id != self.offer.session_id {
            return Err(Rejected::Mismatch);
        }
        record.verify_digest().map_err(|_| Rejected::Mismatch)?;
        if !self.matches_account(record, snapshot) {
            return Err(Rejected::Mismatch);
        }
        if !snapshot.devices.contains(phone_key) {
            return Err(Rejected::Membership);
        }
        let replay = match pending {
            None => false,
            Some(pending)
                if pending.digest == record.digest && pending.encode() == record.encode() =>
            {
                true
            }
            Some(pending) => {
                return Ok(Settled {
                    ack: Ack::Conflict(pending.digest),
                    save: false,
                });
            }
        };
        if !replay {
            self.check_new_occupancy(record, snapshot, now)?;
        }
        let signer = record
            .intent
            .recover_add_device_signer(&record.domain, &record.owner_signature);
        if signer != Ok(snapshot.owner) {
            return Err(Rejected::Mismatch);
        }
        Ok(Settled {
            ack: Ack::Saved(record.digest),
            save: !replay,
        })
    }

    fn matches_account(&self, record: &DeviceActionApproval, snapshot: &AccountSnapshot) -> bool {
        record.operation == ApprovalOperation::Add
            && record.domain.chain_id == snapshot.chain_id
            && record.domain.verifying_contract == snapshot.registry
            && record.intent.qid == snapshot.qid
            && record.intent.device_key == self.offer.device_key
            && record.expected_owner == snapshot.owner
    }

    /// A new approval must be executable now: the current nonce, a deadline not yet passed
    /// and within the protocol's window, and this offer still fresh.
    fn check_new_occupancy(
        &self,
        record: &DeviceActionApproval,
        snapshot: &AccountSnapshot,
        now: u64,
    ) -> Result<(), Rejected> {
        let deadline = record.intent.deadline;
        if record.intent.nonce != snapshot.nonce
            || snapshot.chain_time > deadline
            || deadline
                > snapshot
                    .chain_time
                    .saturating_add(DEVICE_ACTION_DEADLINE_SECONDS)
        {
            return Err(Rejected::Mismatch);
        }
        self.fresh(now)
    }
}

/// A new offer for `identity` reachable at `addrs` (already ranked), with its `qop-pair1.`
/// code. When two addresses make the code too long, the first one alone is used.
pub fn new_offer(
    identity: &Identity,
    addrs: &[String],
    now: u64,
) -> Result<(PairingOffer, String), PairingError> {
    let mut offer = PairingOffer {
        addrs: addrs.to_vec(),
        chain_id: identity.chain_id,
        device_key: identity.device_key,
        expires_at: now + PAIRING_TTL_SECONDS,
        qid: identity.qid,
        registry: identity.registry,
        secret: B256::from(random_32()),
        session_id: B256::from(random_32()),
    };
    match offer.encode() {
        Err(PairingError::Oversized) if offer.addrs.len() > 1 => {
            offer.addrs.truncate(1);
            let code = offer.encode()?;
            Ok((offer, code))
        }
        result => result.map(|code| (offer, code)),
    }
}

/// The non-loopback interface addresses wildcard listeners stand for (IPv6 link-local excluded).
pub fn local_addresses() -> Vec<String> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|interface| !interface.is_loopback())
        .filter_map(|interface| match interface.ip() {
            IpAddr::V4(ip) => Some(ip.to_string()),
            IpAddr::V6(ip) if (ip.segments()[0] & 0xffc0) != 0xfe80 => Some(ip.to_string()),
            IpAddr::V6(_) => None,
        })
        .collect()
}

/// The offer's addresses: the relay circuit first, then concrete listen addresses ranked
/// LAN-first, at most [`PAIRING_MAX_ADDRESSES`] (`selectPairingAddrs`).
pub fn select_pairing_addrs(
    listen: &[String],
    circuit: Option<&str>,
    local: &[String],
) -> Vec<String> {
    let mut dialable: Vec<String> = listen
        .iter()
        .flat_map(|address| expand_listen_address(address, local))
        .collect();
    dialable.sort_by_key(|address| pairing_addr_rank(address));
    let mut unique: Vec<String> = Vec::new();
    for address in circuit.map(str::to_owned).into_iter().chain(dialable) {
        if !unique.contains(&address) && unique.len() < PAIRING_MAX_ADDRESSES {
            unique.push(address);
        }
    }
    unique
}

fn expand_listen_address(address: &str, local: &[String]) -> Vec<String> {
    let expand = |wildcard: &str, family: &str, v6: bool| {
        local
            .iter()
            .filter(|host| host.contains(':') == v6)
            .map(|host| address.replacen(wildcard, &format!("/{family}/{host}/"), 1))
            .collect()
    };
    if address.starts_with("/ip4/0.0.0.0/") {
        expand("/ip4/0.0.0.0/", "ip4", false)
    } else if address.starts_with("/ip6/::/") {
        expand("/ip6/::/", "ip6", true)
    } else {
        vec![address.to_owned()]
    }
}

fn host_after<'a>(address: &'a str, marker: &str) -> Option<&'a str> {
    let rest = &address[address.find(marker)? + marker.len()..];
    Some(rest.split('/').next().unwrap_or(rest))
}

fn pairing_addr_rank(address: &str) -> u8 {
    if address.contains("/p2p-circuit/") {
        return 0;
    }
    if ["/dns/", "/dns4/", "/dns6/"]
        .iter()
        .any(|dns| address.contains(dns))
    {
        return 1;
    }
    let ip4 = host_after(address, "/ip4/");
    match ip4 {
        Some("127.0.0.1") => return 90,
        Some(host) if host.starts_with("192.168.") => return 10,
        Some(host) if host.starts_with("10.") => return 11,
        Some(host) if is_rfc1918_block16(host) => return 30,
        _ => {}
    }
    match host_after(address, "/ip6/")
        .map(str::to_lowercase)
        .as_deref()
    {
        Some("::1") => 90,
        Some(host) if host.starts_with("fe80:") => 80,
        Some(_) => 20,
        None if ip4.is_some() => 25,
        None => 40,
    }
}

fn is_rfc1918_block16(host: &str) -> bool {
    host.strip_prefix("172.")
        .and_then(|rest| rest.split('.').next())
        .and_then(|octet| octet.parse::<u8>().ok())
        .is_some_and(|octet| (16..=31).contains(&octet))
}

/// The whole exchange, account reads included (as sync's, the CLI's `INBOUND_READ_TIMEOUT_MS`).
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(15);
/// Pairing streams handled at once; more are reset. One phone pairs, so a few covers its retries.
pub const MAX_PAIRING_STREAMS: usize = 4;

/// What [`serve`] needs besides the stream and its session.
pub struct PairContext<C, A> {
    pub chain: C,
    pub api: A,
    pub store: Arc<Mutex<Store>>,
    pub qid: U256,
    pub chain_id: U256,
    pub registry: Address,
}

/// Why serving one pairing stream failed; the stream has been reset.
#[derive(Debug)]
pub enum ServeError {
    Rejected(Rejected),
    /// Unreadable frame, or one a desktop never receives.
    Frame,
    /// The account could not be read (or does not exist).
    Chain,
    Store(String),
    Stream(crate::node::NodeError),
    Timeout,
}

/// Serves one inbound `/qop/pair/1` stream: read the frame to EOF, check it against a fresh
/// account read, reply, half-close. Returns the approval reply when there was one.
pub async fn serve<C: Chain, A: Api>(
    mut stream: Stream,
    session: Arc<tokio::sync::Mutex<PairingSession>>,
    ctx: &PairContext<C, A>,
) -> Result<Option<Ack>, ServeError> {
    let result = tokio::time::timeout(EXCHANGE_TIMEOUT, exchange(&mut stream, &session, ctx))
        .await
        .unwrap_or(Err(ServeError::Timeout));
    if result.is_err() {
        stream.reset();
    }
    result
}

async fn exchange<C: Chain, A: Api>(
    stream: &mut Stream,
    session: &tokio::sync::Mutex<PairingSession>,
    ctx: &PairContext<C, A>,
) -> Result<Option<Ack>, ServeError> {
    let bytes = stream
        .read_to_end(PAIRING_FRAME_MAX_BYTES)
        .await
        .map_err(ServeError::Stream)?;
    let frame = PairingFrame::decode(&bytes).map_err(|_| ServeError::Frame)?;
    let snapshot = snapshot(ctx).await.ok_or(ServeError::Chain)?;
    let peer = stream.peer.to_base58();
    let now = super::now_seconds();
    let (reply, ack) = match frame {
        PairingFrame::Hello {
            challenge,
            secret,
            session_id,
        } => {
            let phone_key =
                device_key_from_peer_id(&peer).ok_or(ServeError::Rejected(Rejected::Mismatch))?;
            let ack = session.lock().await.hello(
                &peer,
                phone_key,
                &snapshot,
                (challenge, secret, session_id),
                now,
            );
            (ack.map_err(ServeError::Rejected)?, None)
        }
        PairingFrame::Approval { record, session_id } => {
            // Held across the store round trip so two approvals cannot interleave.
            let session = session.lock().await;
            let store = &ctx.store;
            let pending = enrollment::load_occupying(
                || store.lock().unwrap().approval(),
                || store.lock().unwrap().clear_approval(),
                &ctx.chain,
                &ctx.api,
            )
            .await
            .map_err(|error| ServeError::Store(error.to_string()))?;
            let settled = session
                .approval(&peer, &record, &snapshot, session_id, pending.as_ref(), now)
                .map_err(ServeError::Rejected)?;
            if settled.save {
                save_for_current_key(&store.lock().unwrap(), &record)?;
            }
            let session_id = session.offer().session_id;
            let reply = match settled.ack {
                Ack::Saved(digest) => PairingFrame::ApprovalSaved { digest, session_id },
                Ack::Conflict(digest) => PairingFrame::ApprovalConflict { digest, session_id },
            };
            (reply, Some(settled.ack))
        }
        _ => return Err(ServeError::Frame),
    };
    let bytes = reply.encode().map_err(|_| ServeError::Frame)?;
    stream
        .send_message(bytes)
        .await
        .map_err(ServeError::Stream)?;
    Ok(ack)
}

/// Saves `record` only while it adds the stored identity's key, checked under the same store
/// lock: a rotation since this offer was made (which clears the approval) wins over a handler
/// still finishing on the old key.
fn save_for_current_key(store: &Store, record: &DeviceActionApproval) -> Result<(), ServeError> {
    let error = |error: StoreError| ServeError::Store(error.to_string());
    let current = store.identity().map_err(error)?.map(|identity| identity.device_key);
    if current != Some(record.intent.device_key) {
        return Err(ServeError::Rejected(Rejected::Expired));
    }
    store.save_approval(record).map_err(error)
}

async fn snapshot<C: Chain, A>(ctx: &PairContext<C, A>) -> Option<AccountSnapshot> {
    let (account, chain_time) = ctx.chain.account_with_time(ctx.qid).await.ok()??;
    Some(AccountSnapshot {
        chain_id: ctx.chain_id,
        chain_time,
        devices: account.devices,
        nonce: account.nonce,
        owner: account.owner,
        qid: account.qid,
        registry: ctx.registry,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::testing::{
        CHAIN_ID, DEVICE_KEY, OWNER, PHONE_KEY, QID, REGISTRY, approval, signed_approval,
    };

    const NOW: u64 = 1_700_000_000;
    const DEADLINE: u64 = 1_700_003_600;

    fn offer() -> PairingOffer {
        PairingOffer {
            addrs: vec!["/ip4/127.0.0.1/udp/4001/quic-v1/p2p/12D3KooWC7cDcNR4J3NC9y1gTkqafZKmnjCUvrRMxU2LMugGJGgy".into()],
            chain_id: U256::from(CHAIN_ID),
            device_key: DEVICE_KEY,
            expires_at: DEADLINE,
            qid: U256::from(QID),
            registry: REGISTRY,
            secret: B256::repeat_byte(0x11),
            session_id: B256::repeat_byte(0x22),
        }
    }

    fn snapshot() -> AccountSnapshot {
        AccountSnapshot {
            chain_id: U256::from(CHAIN_ID),
            chain_time: 1_700_003_000,
            devices: vec![PHONE_KEY],
            nonce: U256::from(9),
            owner: OWNER,
            qid: U256::from(QID),
            registry: REGISTRY,
        }
    }

    fn hello() -> (B256, B256, B256) {
        (B256::repeat_byte(0x33), offer().secret, offer().session_id)
    }

    fn claimed() -> PairingSession {
        let mut session = PairingSession::new(offer());
        session
            .hello("phone-a", PHONE_KEY, &snapshot(), hello(), NOW)
            .expect("hello");
        session
    }

    // Ports of `cli/test/pairing-session.test.ts`.

    #[test]
    fn claims_the_first_phone_and_rejects_a_second_peer() {
        offer().encode().expect("the fixture offer encodes");
        let mut session = PairingSession::new(offer());
        let ack = session
            .hello("phone-a", PHONE_KEY, &snapshot(), hello(), NOW)
            .expect("hello");
        assert!(matches!(ack, PairingFrame::HelloAck { challenge, .. } if challenge == hello().0));
        // The same phone may say hello again; another may not.
        assert!(
            session
                .hello("phone-a", PHONE_KEY, &snapshot(), hello(), NOW)
                .is_ok()
        );
        assert_eq!(
            session.hello("phone-b", PHONE_KEY, &snapshot(), hello(), NOW),
            Err(Rejected::Claimed)
        );
    }

    #[test]
    fn rejects_hello_after_the_offer_expires_or_is_replaced() {
        let mut session = PairingSession::new(offer());
        assert_eq!(
            session.hello("phone-a", PHONE_KEY, &snapshot(), hello(), DEADLINE + 1),
            Err(Rejected::Expired)
        );
        session.retire();
        assert_eq!(
            session.hello("phone-a", PHONE_KEY, &snapshot(), hello(), NOW),
            Err(Rejected::Expired)
        );
    }

    #[test]
    fn rejects_a_wrong_secret_session_or_non_member_phone() {
        let mut session = PairingSession::new(offer());
        let (challenge, secret, session_id) = hello();
        let wrong = B256::repeat_byte(0x44);
        assert_eq!(
            session.hello(
                "p",
                PHONE_KEY,
                &snapshot(),
                (challenge, wrong, session_id),
                NOW
            ),
            Err(Rejected::Secret)
        );
        assert_eq!(
            session.hello("p", PHONE_KEY, &snapshot(), (challenge, secret, wrong), NOW),
            Err(Rejected::Mismatch)
        );
        assert_eq!(
            session.hello("p", wrong, &snapshot(), hello(), NOW),
            Err(Rejected::Membership)
        );
        let other_account = AccountSnapshot {
            qid: U256::from(7),
            ..snapshot()
        };
        assert_eq!(
            session.hello("p", PHONE_KEY, &other_account, hello(), NOW),
            Err(Rejected::Mismatch)
        );
    }

    #[test]
    fn acks_an_approval_replays_it_and_conflicts_on_a_different_digest() {
        let session = claimed();
        let record = approval(9, DEADLINE);
        let mut stored: Option<DeviceActionApproval> = None;

        let first = session
            .approval(
                "phone-a",
                &record,
                &snapshot(),
                offer().session_id,
                stored.as_ref(),
                NOW,
            )
            .unwrap();
        assert_eq!(
            first,
            Settled {
                ack: Ack::Saved(record.digest),
                save: true
            }
        );
        stored = Some(record.clone());

        // The phone lost approvalSaved: the identical record replays it, even once the nonce
        // moved on and the offer expired, and is not saved twice.
        let later = AccountSnapshot {
            nonce: U256::from(10),
            ..snapshot()
        };
        let replay = session
            .approval(
                "phone-a",
                &record,
                &later,
                offer().session_id,
                stored.as_ref(),
                DEADLINE + 1,
            )
            .unwrap();
        assert_eq!(
            replay,
            Settled {
                ack: Ack::Saved(record.digest),
                save: false
            }
        );

        // The phone was released and signed a replacement: ours is still pending.
        let other = approval(10, DEADLINE);
        let conflict = session
            .approval(
                "phone-a",
                &other,
                &later,
                offer().session_id,
                stored.as_ref(),
                NOW,
            )
            .unwrap();
        assert_eq!(
            conflict,
            Settled {
                ack: Ack::Conflict(record.digest),
                save: false
            }
        );
    }

    #[test]
    fn rejects_a_matching_digest_whose_signature_does_not_recover_the_owner() {
        let forged = signed_approval(9, DEADLINE, 2);
        let result = claimed().approval(
            "phone-a",
            &forged,
            &snapshot(),
            offer().session_id,
            None,
            NOW,
        );
        assert_eq!(result, Err(Rejected::Mismatch));
    }

    #[test]
    fn rejects_new_approvals_that_cannot_execute_now() {
        let session = claimed();
        let check = |record: &DeviceActionApproval, now| {
            session.approval(
                "phone-a",
                record,
                &snapshot(),
                offer().session_id,
                None,
                now,
            )
        };
        // Stale nonce.
        assert_eq!(check(&approval(8, DEADLINE), NOW), Err(Rejected::Mismatch));
        // Deadline already passed on chain, or beyond the protocol's window.
        assert_eq!(
            check(&approval(9, snapshot().chain_time - 1), NOW),
            Err(Rejected::Mismatch)
        );
        assert_eq!(
            check(&approval(9, snapshot().chain_time + 601), NOW),
            Err(Rejected::Mismatch)
        );
        // The offer expired before the approval arrived.
        assert_eq!(
            check(&approval(9, DEADLINE), DEADLINE),
            Err(Rejected::Expired)
        );
        // Chain time equal to the deadline is still executable.
        assert!(check(&approval(9, snapshot().chain_time), NOW).is_ok());
    }

    #[test]
    fn rejects_approvals_before_hello_or_from_another_peer() {
        let record = approval(9, DEADLINE);
        let fresh = PairingSession::new(offer());
        assert_eq!(
            fresh.approval(
                "phone-a",
                &record,
                &snapshot(),
                offer().session_id,
                None,
                NOW
            ),
            Err(Rejected::Unclaimed)
        );
        assert_eq!(
            claimed().approval(
                "phone-b",
                &record,
                &snapshot(),
                offer().session_id,
                None,
                NOW
            ),
            Err(Rejected::Claimed)
        );
        // The claiming phone was removed from the account meanwhile.
        let removed = AccountSnapshot {
            devices: vec![],
            ..snapshot()
        };
        assert_eq!(
            claimed().approval("phone-a", &record, &removed, offer().session_id, None, NOW),
            Err(Rejected::Membership)
        );
    }

    // Ports of `cli/test/pairing-addresses.test.ts`.

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn advertises_a_reserved_relay_before_concrete_lan_addresses() {
        let circuit = "/dns/relay.example/udp/1234/quic-v1/p2p/relay/p2p-circuit/p2p/device";
        let listen = strings(&[
            "/ip4/0.0.0.0/udp/1234/quic-v1/p2p/device",
            "/ip6/::/udp/1234/quic-v1/p2p/device",
        ]);
        assert_eq!(
            select_pairing_addrs(&listen, Some(circuit), &strings(&["192.168.1.10"])),
            [circuit, "/ip4/192.168.1.10/udp/1234/quic-v1/p2p/device"]
        );
    }

    #[test]
    fn offers_nothing_when_only_wildcard_listeners_exist() {
        assert!(
            select_pairing_addrs(&strings(&["/ip4/0.0.0.0/udp/1234/quic-v1"]), None, &[])
                .is_empty()
        );
    }

    #[test]
    fn expands_dual_stack_wildcards_and_keeps_dns_listen_addresses() {
        let listen = strings(&[
            "/ip4/0.0.0.0/udp/1234/quic-v1/p2p/device",
            "/ip6/::/udp/1234/quic-v1/p2p/device",
        ]);
        assert_eq!(
            select_pairing_addrs(&listen, None, &strings(&["192.168.1.10", "2001:db8::1"])),
            [
                "/ip4/192.168.1.10/udp/1234/quic-v1/p2p/device",
                "/ip6/2001:db8::1/udp/1234/quic-v1/p2p/device"
            ]
        );
        let dns = strings(&["/dns/relay.example/udp/4001/quic-v1/p2p/relay"]);
        assert_eq!(
            select_pairing_addrs(&dns, None, &strings(&["192.168.1.10"])),
            dns
        );
    }

    #[test]
    fn prefers_lan_over_docker_when_the_budget_is_two() {
        let circuit = "/dns/relay.example/udp/1234/quic-v1/p2p/relay/p2p-circuit/p2p/device";
        assert_eq!(
            select_pairing_addrs(
                &strings(&["/ip4/0.0.0.0/udp/1234/quic-v1/p2p/device"]),
                Some(circuit),
                &strings(&["172.17.0.2", "192.168.1.10"])
            ),
            [circuit, "/ip4/192.168.1.10/udp/1234/quic-v1/p2p/device"]
        );
    }

    #[test]
    fn a_new_offer_round_trips_through_its_code() {
        let identity = Identity {
            handle: "alice".into(),
            qid: U256::from(QID),
            chain_id: U256::from(CHAIN_ID),
            registry: REGISTRY,
            device_key: DEVICE_KEY,
            linked: false,
        };
        let (offer, code) = new_offer(&identity, &offer().addrs, NOW).unwrap();
        assert_eq!(offer.expires_at, NOW + PAIRING_TTL_SECONDS);
        assert_eq!(PairingOffer::decode(&code, NOW).unwrap(), offer);
    }

    #[test]
    fn approvals_are_saved_only_for_the_stored_key() {
        let dir = std::env::temp_dir().join(format!("qop-pairing-rotated-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store::open(&dir).unwrap();
        let mut identity = Identity {
            handle: "alice".into(),
            qid: U256::from(QID),
            chain_id: U256::from(CHAIN_ID),
            registry: REGISTRY,
            device_key: DEVICE_KEY,
            linked: false,
        };
        let record = approval(9, DEADLINE);

        // Rotated while the old offer's handler was still working: its approval is dropped.
        identity.device_key = B256::repeat_byte(0x44);
        store.save_identity(&identity).unwrap();
        assert!(matches!(
            save_for_current_key(&store, &record),
            Err(ServeError::Rejected(Rejected::Expired))
        ));
        assert!(store.approval().unwrap().is_none());

        identity.device_key = DEVICE_KEY;
        store.save_identity(&identity).unwrap();
        save_for_current_key(&store, &record).unwrap();
        assert!(store.approval().unwrap().is_some());
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
