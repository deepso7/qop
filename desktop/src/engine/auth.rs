//! Live peer authorization, bound to one transport connection (`p2p-sessions.ts`), plus the gate
//! every chat read and write passes.
//!
//! - A peer is authorized for one connection only, after a registry read shows its device key
//!   as an active member of the account it claims. The read must be at a head strictly newer than
//!   the last one that confirmed this connection (`p2p-sessions.ts:204`), so a stuck or caching
//!   RPC cannot extend authorization by replaying an old answer. Authorization lasts
//!   [`MAX_AUTH_AGE_MS`] of monotonic time from that read.
//! - A verification that the connection outlived, or that an invalidation overtook, writes
//!   nothing (`:246`): connections carry a serial, and invalidation bumps an epoch.
//! - Callers bind the result to the account they meant (chat frames carry no recipient, so a
//!   sender checks the QID it chose) and recheck [`Auth::is_verified`] right before writing.
//! - [`Auth::allowed`] is the CLI's `guardSensitive`, plus linked gating: it is false while this
//!   device's own membership is unverified ([`Auth::set_ready`]) and after a lifecycle
//!   invalidation (sleep, stall, clock step; see [`super::lifecycle`]).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use alloy_primitives::U256;
use minip2p::{ConnectionId, PeerId};

use super::Chain;
use super::lifecycle::{Clock, Lifecycle};
use crate::rpc::{Account, ReadError};
use crate::wire::{device_key_from_peer_id, peer_id_from_device_key};

/// How long one confirmation authorizes a connection, in monotonic milliseconds.
pub const MAX_AUTH_AGE_MS: i128 = 60_000;

/// An account a peer was verified as.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Contact {
    pub qid: U256,
    pub handle: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerifyError {
    /// The connection closed or was replaced, or authorization was invalidated meanwhile.
    Closed,
    /// Not an active device of the claimed account (or the wrong account).
    Identity,
    /// The registry answered at a head no newer than the last confirmation.
    Stale,
    /// The registry could not be read.
    Rpc,
}

impl VerifyError {
    /// Whether this failure says more about our view of the chain than about the peer: it
    /// pauses messaging until our own membership is read again.
    pub fn pauses(self) -> bool {
        matches!(self, Self::Stale | Self::Rpc)
    }
}

struct Authorized {
    at_ms: i128,
    contact: Contact,
}

struct Session {
    peer: PeerId,
    /// Tells this session apart from a later one on a reused connection id.
    serial: u64,
    authorization: Option<Authorized>,
    /// The head of the last confirmation. Survives failures and invalidation.
    last_block: Option<u64>,
    epoch: u64,
    /// One verification at a time per connection.
    permit: Arc<tokio::sync::Mutex<()>>,
}

struct Inner {
    sessions: HashMap<ConnectionId, Session>,
    epoch: u64,
    serial: u64,
    lifecycle: Lifecycle,
    /// This device's own membership is verified.
    ready: bool,
    invalidations: u64,
}

impl Inner {
    /// Also unreadies messaging: only a fresh read of our own membership ([`Auth::set_ready`])
    /// lets chat through again.
    fn invalidate(&mut self) {
        self.ready = false;
        self.epoch += 1;
        self.invalidations += 1;
        for session in self.sessions.values_mut() {
            session.authorization = None;
            session.epoch = self.epoch;
        }
    }

    fn current(&mut self, conn: ConnectionId, serial: u64) -> Option<&mut Session> {
        self.sessions
            .get_mut(&conn)
            .filter(|session| session.serial == serial)
    }
}

/// Shared by the engine and its chat tasks.
pub struct Auth {
    inner: Mutex<Inner>,
    clock: Arc<dyn Clock>,
}

impl Auth {
    pub fn new(clock: Arc<dyn Clock>) -> Auth {
        Auth {
            inner: Mutex::new(Inner {
                sessions: HashMap::new(),
                epoch: 0,
                serial: 0,
                lifecycle: Lifecycle::new(clock.as_ref()),
                ready: false,
                invalidations: 0,
            }),
            clock,
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().expect("auth lock")
    }

    fn now(&self) -> i128 {
        self.clock.monotonic_ms()
    }

    /// A connection (or a stream on it) appeared. The same peer keeps its session; a reused id
    /// with another peer starts a new one.
    pub fn opened(&self, conn: ConnectionId, peer: &PeerId) {
        let mut inner = self.lock();
        if inner.sessions.get(&conn).is_some_and(|s| &s.peer == peer) {
            return;
        }
        inner.serial += 1;
        let session = Session {
            peer: peer.clone(),
            serial: inner.serial,
            authorization: None,
            last_block: None,
            epoch: inner.epoch,
            permit: Arc::default(),
        };
        inner.sessions.insert(conn, session);
    }

    /// The connection ended; its authorization goes with it.
    pub fn closed(&self, conn: ConnectionId, peer: &PeerId) {
        let mut inner = self.lock();
        if inner.sessions.get(&conn).is_some_and(|s| &s.peer == peer) {
            inner.sessions.remove(&conn);
        }
    }

    /// Forgets every connection (the node stopped).
    pub fn clear(&self) {
        let mut inner = self.lock();
        inner.sessions.clear();
        inner.epoch += 1;
    }

    /// Drops every authorization (keeping connections and their last heads), cancels
    /// verifications in flight, and pauses messaging until [`Auth::set_ready`].
    pub fn invalidate(&self) {
        self.lock().invalidate();
    }

    /// Whether this device's own membership is verified; messaging stops while it is not.
    pub fn set_ready(&self, ready: bool) {
        self.lock().ready = ready;
    }

    /// Observes the clocks (the engine's once-a-second tick). Returns how many invalidations
    /// have happened so far, from any cause, so the engine can pause on a new one.
    pub fn observe(&self) -> u64 {
        let mut inner = self.lock();
        if inner.lifecycle.take_invalidation(self.clock.as_ref()) {
            inner.invalidate();
        }
        inner.invalidations
    }

    /// Whether a chat read or write may proceed now: own membership verified and no lifecycle
    /// invalidation since the last check (which this consumes, invalidating everything).
    pub fn allowed(&self) -> bool {
        let mut inner = self.lock();
        if inner.lifecycle.take_invalidation(self.clock.as_ref()) {
            inner.invalidate();
            return false;
        }
        inner.ready
    }

    /// Whether `conn` (still to `peer`) holds a live authorization for account `qid`.
    pub fn is_verified(&self, conn: ConnectionId, peer: &PeerId, qid: U256) -> bool {
        let now = self.now();
        let inner = self.lock();
        inner.sessions.get(&conn).is_some_and(|session| {
            &session.peer == peer
                && session.authorization.as_ref().is_some_and(|auth| {
                    auth.contact.qid == qid && now - auth.at_ms < MAX_AUTH_AGE_MS
                })
        })
    }

    /// Verifies that `peer`, on `conn`, is an active device of the account called `handle`, at a
    /// head strictly newer than this connection's last confirmation; a live authorization for
    /// the same handle is reused until it ages out.
    pub async fn verify<C: Chain>(
        &self,
        chain: &C,
        conn: ConnectionId,
        peer: &PeerId,
        handle: &str,
    ) -> Result<Contact, VerifyError> {
        let (permit, serial) = {
            let inner = self.lock();
            let session = inner
                .sessions
                .get(&conn)
                .filter(|s| &s.peer == peer)
                .ok_or(VerifyError::Closed)?;
            (session.permit.clone(), session.serial)
        };
        let _permit = permit.lock().await;

        let (epoch, prior) = {
            let now = self.now();
            let mut inner = self.lock();
            let session = inner.current(conn, serial).ok_or(VerifyError::Closed)?;
            if let Some(cached) = &session.authorization {
                if cached.contact.handle != handle {
                    session.authorization = None;
                    return Err(VerifyError::Identity);
                }
                if now - cached.at_ms < MAX_AUTH_AGE_MS {
                    return Ok(cached.contact.clone());
                }
            }
            (session.epoch, session.last_block)
        };

        let result = self.read(chain, peer, handle, prior).await;
        let at_ms = self.now();
        let mut inner = self.lock();
        let session = inner
            .current(conn, serial)
            .filter(|session| session.epoch == epoch)
            .ok_or(VerifyError::Closed)?;
        match result {
            Ok((contact, block)) => {
                session.last_block = Some(block);
                session.authorization = Some(Authorized {
                    at_ms,
                    contact: contact.clone(),
                });
                Ok(contact)
            }
            Err(error) => {
                session.authorization = None;
                Err(error)
            }
        }
    }

    /// The registry read behind [`Auth::verify`]: the peer's own key, its account, the claimed
    /// handle, and a strictly newer head.
    async fn read<C: Chain>(
        &self,
        chain: &C,
        peer: &PeerId,
        handle: &str,
        prior: Option<u64>,
    ) -> Result<(Contact, u64), VerifyError> {
        let device_key = device_key_from_peer_id(&peer.to_base58()).ok_or(VerifyError::Identity)?;
        let account = chain
            .lookup_device_key(device_key)
            .await
            .map_err(|error| match error {
                ReadError::Rpc => VerifyError::Rpc,
                _ => VerifyError::Identity,
            })?
            .filter(|account| account.handle == handle && account.devices.contains(&device_key))
            .ok_or(VerifyError::Identity)?;
        if prior.is_some_and(|prior| account.block <= prior) {
            return Err(VerifyError::Stale);
        }
        let contact = Contact {
            qid: account.qid,
            handle: account.handle,
        };
        Ok((contact, account.block))
    }

    /// Where to deliver to `contact`, best first (`recipientPeerIds`): peers already authorized
    /// as it, then its active devices (connected ones first). `account` is a fresh lookup of the
    /// handle, a dial hint only; it never authorizes anything.
    pub fn recipient_peers(&self, contact: &Contact, account: &Account) -> Vec<PeerId> {
        let now = self.now();
        let inner = self.lock();
        let mut peers: Vec<PeerId> = Vec::new();
        let mut push = |peer: &PeerId| {
            if !peers.contains(peer) {
                peers.push(peer.clone());
            }
        };
        for session in inner.sessions.values() {
            if session
                .authorization
                .as_ref()
                .is_some_and(|auth| auth.contact == *contact && now - auth.at_ms < MAX_AUTH_AGE_MS)
            {
                push(&session.peer);
            }
        }
        if account.handle != contact.handle || account.qid != contact.qid {
            return peers;
        }
        let roster: Vec<PeerId> = account
            .devices
            .iter()
            .map(peer_id_from_device_key)
            .collect();
        for session in inner.sessions.values() {
            if roster.contains(&session.peer) {
                push(&session.peer);
            }
        }
        roster.iter().for_each(push);
        peers
    }
}

/// What a read of this device's own membership means while linked. Only an affirmative removal
/// revokes; anything uncertain pauses messaging until a later read at a newer head succeeds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SelfVerdict {
    /// An active member of the account, confirmed at this (strictly newer) head.
    Member(u64),
    /// Not an active member, and the registry marks the key removed.
    Removed,
    /// RPC failure, a head no newer than the last confirmation, or no membership without the
    /// removal marker.
    Unverified,
}

/// Judges one self-membership read: `account` is `lookupDeviceKey(own key)`, `removed` the
/// registry's removal marker (read only when not a member), `prior` the head of the last
/// confirmation.
pub fn judge_self(
    qid: U256,
    account: &Result<Option<Account>, ReadError>,
    removed: Option<bool>,
    prior: Option<u64>,
) -> SelfVerdict {
    match account {
        Ok(Some(account)) if account.qid == qid => {
            if prior.is_some_and(|prior| account.block <= prior) {
                SelfVerdict::Unverified
            } else {
                SelfVerdict::Member(account.block)
            }
        }
        Ok(_) if removed == Some(true) => SelfVerdict::Removed,
        _ => SelfVerdict::Unverified,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::lifecycle::ManualClock;
    use crate::engine::testing::{FakeChain, account_with};
    use alloy_primitives::B256;

    const BOB_QID: u64 = 7;
    const MALLORY_QID: u64 = 8;

    fn bob_key() -> B256 {
        B256::repeat_byte(0xb0)
    }

    fn bob_peer() -> PeerId {
        peer_id_from_device_key(&bob_key())
    }

    fn conn(id: u64) -> ConnectionId {
        ConnectionId::new(id)
    }

    fn setup() -> (Auth, ManualClock, FakeChain) {
        let clock = ManualClock::default();
        let auth = Auth::new(Arc::new(clock.clone()));
        auth.set_ready(true);
        let chain = FakeChain::default();
        chain.add_account(account_with(BOB_QID, "bob", vec![bob_key()]));
        (auth, clock, chain)
    }

    #[tokio::test]
    async fn verifies_an_active_device_and_binds_it_to_the_connection() {
        let (auth, clock, chain) = setup();
        auth.opened(conn(1), &bob_peer());
        let contact = auth.verify(&chain, conn(1), &bob_peer(), "bob").await;
        assert_eq!(contact.map(|c| c.qid), Ok(U256::from(BOB_QID)));
        assert!(auth.is_verified(conn(1), &bob_peer(), U256::from(BOB_QID)));
        // Bound to the connection: another connection to the same peer is not verified.
        assert!(!auth.is_verified(conn(2), &bob_peer(), U256::from(BOB_QID)));
        // A recipient QID mismatch is not verified either.
        assert!(!auth.is_verified(conn(1), &bob_peer(), U256::from(MALLORY_QID)));
        // A claimed handle the device does not belong to is rejected and drops authorization.
        assert_eq!(
            auth.verify(&chain, conn(1), &bob_peer(), "mallory").await,
            Err(VerifyError::Identity)
        );
        assert!(!auth.is_verified(conn(1), &bob_peer(), U256::from(BOB_QID)));
        // And it ages out.
        auth.verify(&chain, conn(1), &bob_peer(), "bob")
            .await
            .unwrap();
        clock.advance(MAX_AUTH_AGE_MS);
        assert!(!auth.is_verified(conn(1), &bob_peer(), U256::from(BOB_QID)));
        auth.closed(conn(1), &bob_peer());
        assert_eq!(
            auth.verify(&chain, conn(1), &bob_peer(), "bob").await,
            Err(VerifyError::Closed)
        );
    }

    #[tokio::test]
    async fn a_stale_or_same_head_answer_never_reauthorizes() {
        let (auth, clock, chain) = setup();
        auth.opened(conn(1), &bob_peer());
        auth.verify(&chain, conn(1), &bob_peer(), "bob")
            .await
            .unwrap();
        clock.advance(MAX_AUTH_AGE_MS);

        // The head is stuck: the same membership at the same block is no new confirmation.
        chain.stick_head(true);
        assert_eq!(
            auth.verify(&chain, conn(1), &bob_peer(), "bob").await,
            Err(VerifyError::Stale)
        );
        assert!(!auth.is_verified(conn(1), &bob_peer(), U256::from(BOB_QID)));

        // Nor after an invalidation (resume): the last head survives it.
        auth.invalidate();
        assert_eq!(
            auth.verify(&chain, conn(1), &bob_peer(), "bob").await,
            Err(VerifyError::Stale)
        );

        // A newer head does.
        chain.stick_head(false);
        assert!(
            auth.verify(&chain, conn(1), &bob_peer(), "bob")
                .await
                .is_ok()
        );
        assert!(VerifyError::Stale.pauses() && VerifyError::Rpc.pauses());
        assert!(!VerifyError::Identity.pauses());
    }

    #[tokio::test]
    async fn an_rpc_failure_is_reported_as_such() {
        let (auth, _, chain) = setup();
        auth.opened(conn(1), &bob_peer());
        chain.fail_lookups(true);
        assert_eq!(
            auth.verify(&chain, conn(1), &bob_peer(), "bob").await,
            Err(VerifyError::Rpc)
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_connection_replaced_mid_verification_gets_nothing() {
        let (auth, _, chain) = setup();
        let auth = Arc::new(auth);
        auth.opened(conn(1), &bob_peer());
        let hold = chain.hold_lookups();
        let verifying = tokio::spawn({
            let (auth, chain) = (auth.clone(), chain.clone());
            async move { auth.verify(&chain, conn(1), &bob_peer(), "bob").await }
        });
        hold.entered().await;
        // The connection closes and the id comes back for another peer before the read lands.
        auth.closed(conn(1), &bob_peer());
        let other = peer_id_from_device_key(&B256::repeat_byte(0xcc));
        auth.opened(conn(1), &other);
        hold.release();
        assert_eq!(verifying.await.unwrap(), Err(VerifyError::Closed));
        assert!(!auth.is_verified(conn(1), &bob_peer(), U256::from(BOB_QID)));
        assert!(!auth.is_verified(conn(1), &other, U256::from(BOB_QID)));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_invalidation_during_verification_cancels_it() {
        let (auth, _, chain) = setup();
        let auth = Arc::new(auth);
        auth.opened(conn(1), &bob_peer());
        let hold = chain.hold_lookups();
        let verifying = tokio::spawn({
            let (auth, chain) = (auth.clone(), chain.clone());
            async move { auth.verify(&chain, conn(1), &bob_peer(), "bob").await }
        });
        hold.entered().await;
        auth.invalidate();
        hold.release();
        assert_eq!(verifying.await.unwrap(), Err(VerifyError::Closed));
        assert!(!auth.is_verified(conn(1), &bob_peer(), U256::from(BOB_QID)));
    }

    #[tokio::test]
    async fn sleep_and_own_membership_gate_messaging() {
        let (auth, clock, chain) = setup();
        auth.opened(conn(1), &bob_peer());
        auth.verify(&chain, conn(1), &bob_peer(), "bob")
            .await
            .unwrap();
        clock.advance(1000);
        assert!(auth.allowed());

        // Asleep for a minute: the next check refuses and drops every authorization.
        clock.sleep(60_000);
        assert!(!auth.allowed());
        assert!(!auth.is_verified(conn(1), &bob_peer(), U256::from(BOB_QID)));
        assert_eq!(auth.observe(), 1);
        clock.advance(1000);
        // Still refused until our own membership is read again, so no task can reauthorize a
        // peer in the meantime.
        assert!(!auth.allowed());
        auth.set_ready(true);
        assert!(auth.allowed());

        auth.set_ready(false);
        assert!(!auth.allowed());
    }

    #[test]
    fn recipients_put_authorized_and_connected_devices_first() {
        let (auth, _, _) = setup();
        let other_key = B256::repeat_byte(0xb1);
        let account = account_with(BOB_QID, "bob", vec![other_key, bob_key()]);
        let contact = Contact {
            qid: U256::from(BOB_QID),
            handle: "bob".into(),
        };
        assert_eq!(
            auth.recipient_peers(&contact, &account),
            vec![peer_id_from_device_key(&other_key), bob_peer()]
        );
        auth.opened(conn(1), &bob_peer());
        assert_eq!(auth.recipient_peers(&contact, &account)[0], bob_peer());
        // A lookup for another account adds nothing to dial.
        let mallory = account_with(MALLORY_QID, "bob", vec![other_key]);
        assert!(auth.recipient_peers(&contact, &mallory).is_empty());
    }

    #[test]
    fn only_a_removal_read_revokes_self() {
        let qid = U256::from(42);
        let member = Ok(Some(account_with(42, "alice", vec![])));
        assert_eq!(judge_self(qid, &member, None, None), SelfVerdict::Member(1));
        // A stuck head replaying membership pauses.
        assert_eq!(
            judge_self(qid, &member, None, Some(1)),
            SelfVerdict::Unverified
        );
        assert_eq!(
            judge_self(qid, &Err(ReadError::Rpc), Some(true), None),
            SelfVerdict::Unverified
        );
        assert_eq!(
            judge_self(qid, &Ok(None), None, None),
            SelfVerdict::Unverified
        );
        assert_eq!(
            judge_self(qid, &Ok(None), Some(false), None),
            SelfVerdict::Unverified
        );
        assert_eq!(
            judge_self(qid, &Ok(None), Some(true), None),
            SelfVerdict::Removed
        );
    }
}
