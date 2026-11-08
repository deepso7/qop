//! The engine: the linking state machine, run as one task on a tokio runtime.
//!
//! ```text
//! Unlinked --handle resolved--> Pairing --approval saved--> AwaitingEnrollment --own read--> Linked
//!                                  ^   <--released / key rotated--'                            |
//!                                  '------------------------------- Revoked <--removal read----'
//! ```
//!
//! The store is the truth: every transition writes it first, then updates [`State`]; a restart
//! loads the same state back ([`Engine::run`] begins with `resume`). The UI never sees the
//! engine, only the [`Model`] it publishes after each event, and sends [`Command`]s back.
//!
//! Network IO never runs on the engine task. Lookups, polls and pairing streams run as spawned
//! tasks and report back as [`Internal`] messages; results that went stale meanwhile (another key,
//! another approval) are dropped. The node thread ([`crate::node`]) feeds [`NodeEvent`]s.
//!
//! Later milestones hook in the same way: chat and sync register their protocols with the node
//! and handle their [`NodeEvent::InboundStream`]s here, gated on `State::Linked`.

pub mod enrollment;
pub mod pairing;
#[cfg(test)]
pub(crate) mod testing;
#[cfg(test)]
mod tests;

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use alloy_primitives::{B256, U256};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

use crate::api::ApiClient;
use crate::config::Config;
use crate::keys::{KeyStore, random_32};
use crate::model::{
    self, Command, EnrollmentProgress, EnterHandle, HandleLookup, LookupError, Messaging, Model,
    NewChat, Offer, Phase, RelayStatus,
};
use crate::node::{Node, NodeConfig, NodeEvent};
use crate::rpc::{Account, ReadError, RegistryReader};
use crate::store::{Identity, Store};
use crate::wire::{
    DeviceActionApproval, DeviceActionStatus, DeviceActionStatusError, PAIR_PROTOCOL,
    device_key_from_secret,
};
use enrollment::{Next, Observation};
use pairing::{PairContext, PairingSession};

/// How often a pairing or enrolling device polls the API and the chain (`pollEnrollmentState`).
const POLL: Duration = Duration::from_secs(2);
/// A linked device re-reads its own membership every this many polls.
const LINKED_POLL_EVERY: u32 = 30;
/// How long pairing waits for a relay reservation before offering LAN addresses only.
const RELAY_WAIT: Duration = Duration::from_secs(15);
const AGENT_VERSION: &str = concat!("qop-desktop/", env!("CARGO_PKG_VERSION"));

/// Registry reads, async. The live implementation is [`RegistryReader`].
pub trait Chain: Clone + Send + Sync + 'static {
    fn lookup_handle(
        &self,
        handle: String,
    ) -> impl Future<Output = Result<Option<Account>, ReadError>> + Send;
    /// The account and the chain time at one head; `None` if it does not exist.
    fn account_with_time(
        &self,
        qid: U256,
    ) -> impl Future<Output = Result<Option<(Account, u64)>, ReadError>> + Send;
    fn membership(
        &self,
        device_key: B256,
    ) -> impl Future<Output = Result<Option<U256>, ReadError>> + Send;
    fn key_removed(&self, device_key: B256)
    -> impl Future<Output = Result<bool, ReadError>> + Send;
    fn latest_timestamp(&self) -> impl Future<Output = Result<u64, ReadError>> + Send;
}

/// The device-action API, async. The live implementation is [`ApiClient`].
pub trait Api: Clone + Send + Sync + 'static {
    fn device_action(
        &self,
        digest: B256,
    ) -> impl Future<Output = Result<DeviceActionStatus, DeviceActionStatusError>> + Send;
}

async fn blocking<T: Send + 'static, E: Send + 'static>(
    failed: E,
    call: impl FnOnce() -> Result<T, E> + Send + 'static,
) -> Result<T, E> {
    tokio::task::spawn_blocking(call)
        .await
        .unwrap_or(Err(failed))
}

impl Chain for RegistryReader {
    async fn lookup_handle(&self, handle: String) -> Result<Option<Account>, ReadError> {
        let reader = self.clone();
        blocking(ReadError::Rpc, move || reader.lookup_handle(&handle)).await
    }

    async fn account_with_time(&self, qid: U256) -> Result<Option<(Account, u64)>, ReadError> {
        let reader = self.clone();
        blocking(ReadError::Rpc, move || {
            reader.account_with_time(qid).map(Some)
        })
        .await
    }

    async fn membership(&self, device_key: B256) -> Result<Option<U256>, ReadError> {
        let reader = self.clone();
        blocking(ReadError::Rpc, move || reader.membership(&device_key)).await
    }

    async fn key_removed(&self, device_key: B256) -> Result<bool, ReadError> {
        let reader = self.clone();
        blocking(ReadError::Rpc, move || reader.key_removed(&device_key)).await
    }

    async fn latest_timestamp(&self) -> Result<u64, ReadError> {
        let reader = self.clone();
        blocking(ReadError::Rpc, move || reader.latest_timestamp()).await
    }
}

impl Api for ApiClient {
    async fn device_action(
        &self,
        digest: B256,
    ) -> Result<DeviceActionStatus, DeviceActionStatusError> {
        let client = self.clone();
        blocking(DeviceActionStatusError::Network, move || {
            client.device_action(&digest).map(|record| record.status)
        })
        .await
    }
}

/// Wall-clock seconds, as offers and deadlines count them.
pub fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// Where linking stands. Mirrors the store, plus nothing that would not survive a restart.
#[derive(Clone, Debug, PartialEq)]
enum State {
    /// Store or key not readable yet; retried on every poll.
    Starting,
    Unlinked,
    Pairing(Identity),
    AwaitingEnrollment {
        identity: Identity,
        approval: Box<DeviceActionApproval>,
        /// Stop waiting was pressed: show a recovery offer (same key) instead of progress.
        recovery: bool,
    },
    Linked(Identity),
    Revoked(String),
}

impl State {
    fn identity(&self) -> Option<&Identity> {
        match self {
            State::Pairing(identity) | State::Linked(identity) => Some(identity),
            State::AwaitingEnrollment { identity, .. } => Some(identity),
            _ => None,
        }
    }

    fn approval(&self) -> Option<&DeviceActionApproval> {
        match self {
            State::AwaitingEnrollment { approval, .. } => Some(approval),
            _ => None,
        }
    }

    /// Whether an offer should be on screen.
    fn wants_offer(&self) -> bool {
        matches!(
            self,
            State::Pairing(_) | State::AwaitingEnrollment { recovery: true, .. }
        )
    }
}

/// Results of spawned work, and timers.
enum Internal {
    Resolved {
        handle: String,
        result: Result<Option<Account>, ReadError>,
    },
    Observed {
        device_key: B256,
        digest: Option<B256>,
        observation: Observation,
    },
    /// A pairing stream finished; the stored approval may have changed.
    PairingDone,
    RelayWaitOver {
        generation: u64,
    },
}

/// The node while a device key exists, and what pairing shows through it.
struct Net {
    node: Node,
    events: UnboundedReceiver<NodeEvent>,
    generation: u64,
    relay: RelayStatus,
    circuit: Option<String>,
    relay_wait_over: bool,
    session: Option<Arc<tokio::sync::Mutex<PairingSession>>>,
    offer: Option<Offer>,
}

impl Net {
    /// Retires the current session (in-flight replays still settle) and hides its offer.
    fn drop_session(&mut self) {
        if let Some(session) = self.session.take() {
            tokio::spawn(async move { session.lock().await.retire() });
        }
        self.offer = None;
    }
}

/// Publishes each new model; the app wires this to the UI (or stdout when headless).
pub type Publish = Box<dyn FnMut(&Model) + Send>;

pub struct Engine<C: Chain, A: Api> {
    config: Config,
    chain: C,
    api: A,
    store: Arc<Mutex<Store>>,
    keys: KeyStore,
    publish: Publish,
    state: State,
    lookup: HandleLookup,
    progress: EnrollmentProgress,
    net: Option<Net>,
    generation: u64,
    polling: bool,
    internal: UnboundedSender<Internal>,
    inbox: Option<UnboundedReceiver<Internal>>,
    published: Option<Model>,
}

impl Engine<RegistryReader, ApiClient> {
    /// The engine over the configured chain and API.
    pub fn live(config: Config, store: Store, keys: KeyStore, publish: Publish) -> Self {
        let chain = RegistryReader::new(&config.rpc_url, config.registry);
        let api = ApiClient::new(config.api_url.clone());
        Engine::new(config, chain, api, store, keys, publish)
    }
}

impl<C: Chain, A: Api> Engine<C, A> {
    pub fn new(
        config: Config,
        chain: C,
        api: A,
        store: Store,
        keys: KeyStore,
        publish: Publish,
    ) -> Self {
        let (internal, inbox) = mpsc::unbounded_channel();
        Engine {
            config,
            chain,
            api,
            store: Arc::new(Mutex::new(store)),
            keys,
            publish,
            state: State::Starting,
            lookup: HandleLookup::Idle,
            progress: EnrollmentProgress::Approved,
            net: None,
            generation: 0,
            polling: false,
            internal,
            inbox: Some(inbox),
            published: None,
        }
    }

    /// Runs until `commands` closes (the UI quit), then shuts the node down.
    pub async fn run(mut self, mut commands: UnboundedReceiver<Command>) {
        let mut inbox = self.inbox.take().expect("run is called once");
        self.resume();
        self.publish_model();
        let mut tick = tokio::time::interval(POLL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut ticks: u32 = 0;
        loop {
            tokio::select! {
                command = commands.recv() => match command {
                    Some(command) => self.command(command),
                    None => break,
                },
                Some(message) = inbox.recv() => self.internal(message),
                Some(event) = next_node_event(&mut self.net) => self.node_event(event),
                _ = tick.tick() => {
                    ticks = ticks.wrapping_add(1);
                    self.tick(ticks);
                }
            }
            self.publish_model();
        }
        if let Some(net) = self.net.take() {
            tokio::task::block_in_place(|| net.node.shutdown());
        }
    }

    fn store(&self) -> std::sync::MutexGuard<'_, Store> {
        self.store.lock().expect("store lock")
    }

    /// Loads the persisted state, repairing what a crash mid-rotation can leave behind.
    fn resume(&mut self) {
        match self.load() {
            Ok(state) => self.enter(state),
            Err(error) => eprintln!("qop: cannot load local state: {error}"),
        }
    }

    fn load(&self) -> Result<State, String> {
        let store = self.store();
        if let Some(handle) = store.revoked().map_err(|e| e.to_string())? {
            return Ok(State::Revoked(handle));
        }
        let Some(mut identity) = store.identity().map_err(|e| e.to_string())? else {
            return Ok(State::Unlinked);
        };
        let Some(secret) = self.keys.load().map_err(|e| e.to_string())? else {
            eprintln!(
                "qop: the device key for @{} is gone; starting over",
                identity.handle
            );
            store.delete_identity().map_err(|e| e.to_string())?;
            return Ok(State::Unlinked);
        };
        let device_key = device_key_from_secret(secret);
        if device_key != identity.device_key {
            if identity.linked {
                return Err("the stored device key does not match the linked identity".into());
            }
            // A rotation saved the new key but not the identity: finish it.
            identity.device_key = device_key;
            store.save_identity(&identity).map_err(|e| e.to_string())?;
            store.clear_approval().map_err(|e| e.to_string())?;
        }
        Ok(if identity.linked {
            State::Linked(identity)
        } else if let Some(approval) = store.approval().map_err(|e| e.to_string())? {
            State::AwaitingEnrollment {
                identity,
                approval: Box::new(approval),
                recovery: false,
            }
        } else {
            State::Pairing(identity)
        })
    }

    /// Moves to `state`: starts or stops the node and pairing to match, and polls at once.
    fn enter(&mut self, state: State) {
        let key = state.identity().map(|identity| identity.device_key);
        if self.state.identity().map(|identity| identity.device_key) != key {
            self.stop_node();
        } else if let Some(net) = &mut self.net {
            // Same key, new phase: whatever was offered belongs to the old one.
            net.drop_session();
        }
        self.state = state;
        if key.is_some() {
            self.start_node();
            self.ensure_offer();
            self.poll();
        }
    }

    fn start_node(&mut self) {
        if self.net.is_some() {
            return;
        }
        let secret = match self.keys.load() {
            Ok(Some(secret)) => secret,
            other => return eprintln!("qop: device key unavailable: {other:?}"),
        };
        let config = NodeConfig {
            secret,
            agent_version: AGENT_VERSION.into(),
            protocols: vec![PAIR_PROTOCOL.into()],
            relays: self.config.relays.clone(),
            listen: self.config.listen.clone(),
        };
        match Node::start(config) {
            Ok((node, events)) => {
                self.generation += 1;
                let generation = self.generation;
                let relays = !self.config.relays.is_empty();
                if relays {
                    let internal = self.internal.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(RELAY_WAIT).await;
                        let _ = internal.send(Internal::RelayWaitOver { generation });
                    });
                }
                self.net = Some(Net {
                    node,
                    events,
                    generation,
                    relay: if relays {
                        RelayStatus::Connecting
                    } else {
                        RelayStatus::LocalOnly
                    },
                    circuit: None,
                    relay_wait_over: !relays,
                    session: None,
                    offer: None,
                });
            }
            Err(error) => eprintln!("qop: node failed to start: {error}"),
        }
    }

    fn stop_node(&mut self) {
        if let Some(mut net) = self.net.take() {
            net.drop_session();
            tokio::task::block_in_place(|| net.node.shutdown());
        }
    }

    /// Shows an offer when the state wants one and the node is reachable enough: a relay
    /// reservation, or the relay wait is over (LAN addresses only).
    fn ensure_offer(&mut self) {
        let Some(identity) = self
            .state
            .identity()
            .filter(|_| self.state.wants_offer())
            .cloned()
        else {
            return;
        };
        let Some(net) = &mut self.net else { return };
        if net.offer.is_some() || !(net.circuit.is_some() || net.relay_wait_over) {
            return;
        }
        let addrs = pairing::select_pairing_addrs(
            net.node.listen_addrs(),
            net.circuit.as_deref(),
            &pairing::local_addresses(),
        );
        if addrs.is_empty() {
            return eprintln!("qop: no listen addresses are available for pairing");
        }
        match pairing::new_offer(&identity, &addrs, now_seconds()) {
            Ok((offer, code)) => {
                net.offer = Some(Offer {
                    code,
                    fingerprint: identity.fingerprint(),
                    expires_at: UNIX_EPOCH + Duration::from_secs(offer.expires_at),
                });
                net.session = Some(Arc::new(tokio::sync::Mutex::new(PairingSession::new(
                    offer,
                ))));
            }
            Err(error) => eprintln!("qop: cannot encode a pairing offer: {error:?}"),
        }
    }

    /// Replaces the offer (and its session) with a fresh one.
    fn regenerate(&mut self) {
        if let Some(net) = &mut self.net {
            net.drop_session();
        }
        self.ensure_offer();
    }

    fn command(&mut self, command: Command) {
        match (command, &self.state) {
            (Command::SubmitHandle(handle), State::Unlinked) => self.submit_handle(handle),
            (Command::RegeneratePairing, state) if state.wants_offer() => self.regenerate(),
            (
                Command::StopWaiting,
                State::AwaitingEnrollment {
                    identity,
                    approval,
                    recovery: false,
                },
            ) => {
                let state = State::AwaitingEnrollment {
                    identity: identity.clone(),
                    approval: approval.clone(),
                    recovery: true,
                };
                self.state = state;
                self.regenerate();
            }
            (Command::Unlink, State::Pairing(_) | State::Linked(_)) => self.unlink(),
            (Command::AcknowledgeRevoked, State::Revoked(_)) => {
                let cleared = self
                    .keys
                    .delete()
                    .map_err(|e| e.to_string())
                    .and_then(|()| self.store().clear_revoked().map_err(|e| e.to_string()));
                match cleared {
                    Ok(()) => self.enter(State::Unlinked),
                    Err(error) => eprintln!("qop: {error}"),
                }
            }
            (command, state) => eprintln!("qop: ignoring {command:?} in {}", state_name(state)),
        }
    }

    fn submit_handle(&mut self, handle: String) {
        if matches!(self.lookup, HandleLookup::Resolving { .. }) {
            return;
        }
        if crate::registry::handle_hash(&handle).is_err() {
            self.lookup = HandleLookup::Failed {
                handle,
                error: LookupError::Invalid,
            };
            return;
        }
        self.lookup = HandleLookup::Resolving {
            handle: handle.clone(),
        };
        let (chain, internal) = (self.chain.clone(), self.internal.clone());
        tokio::spawn(async move {
            let result = chain.lookup_handle(handle.clone()).await;
            let _ = internal.send(Internal::Resolved { handle, result });
        });
    }

    /// The handle resolved: create (or adopt) the device key, durably, then start pairing.
    fn resolved(&mut self, handle: String, result: Result<Option<Account>, ReadError>) {
        if !matches!((&self.state, &self.lookup), (State::Unlinked, HandleLookup::Resolving { handle: h }) if *h == handle)
        {
            return;
        }
        let account = match result {
            Ok(Some(account)) => account,
            Ok(None) => {
                return self.lookup = HandleLookup::Failed {
                    handle,
                    error: LookupError::NotFound,
                };
            }
            Err(ReadError::InvalidHandle) => {
                return self.lookup = HandleLookup::Failed {
                    handle,
                    error: LookupError::Invalid,
                };
            }
            Err(_) => {
                return self.lookup = HandleLookup::Failed {
                    handle,
                    error: LookupError::Unreachable,
                };
            }
        };
        match self.create_identity(handle.clone(), account.qid) {
            Ok(identity) => {
                self.lookup = HandleLookup::Idle;
                self.enter(State::Pairing(identity));
            }
            Err(error) => {
                eprintln!("qop: cannot create the device key: {error}");
                self.lookup = HandleLookup::Failed {
                    handle,
                    error: LookupError::Unreachable,
                };
            }
        }
    }

    /// The key is stored before the identity, so no offer can show a key that was not saved.
    /// A key left behind without an identity is adopted rather than overwritten.
    fn create_identity(&self, handle: String, qid: U256) -> Result<Identity, String> {
        let secret = match self.keys.load().map_err(|e| e.to_string())? {
            Some(secret) => secret,
            None => self.new_key()?,
        };
        let identity = Identity {
            handle,
            qid,
            chain_id: self.config.chain_id,
            registry: self.config.registry,
            device_key: device_key_from_secret(secret),
            linked: false,
        };
        self.store()
            .save_identity(&identity)
            .map_err(|e| e.to_string())?;
        Ok(identity)
    }

    fn new_key(&self) -> Result<[u8; 32], String> {
        let secret = random_32();
        self.keys.save(&secret).map_err(|e| e.to_string())?;
        Ok(secret)
    }

    fn unlink(&mut self) {
        self.stop_node();
        let result = self
            .keys
            .delete()
            .map_err(|e| e.to_string())
            .and_then(|()| self.store().delete_identity().map_err(|e| e.to_string()));
        match result {
            Ok(()) => self.enter(State::Unlinked),
            Err(error) => eprintln!("qop: unlink failed: {error}"),
        }
    }

    fn internal(&mut self, message: Internal) {
        match message {
            Internal::Resolved { handle, result } => self.resolved(handle, result),
            Internal::Observed {
                device_key,
                digest,
                observation,
            } => {
                self.polling = false;
                let current = self.state.identity().map(|identity| identity.device_key);
                if current == Some(device_key)
                    && self.state.approval().map(|approval| approval.digest) == digest
                {
                    self.observed(&observation);
                }
            }
            Internal::PairingDone => self.pairing_done(),
            Internal::RelayWaitOver { generation } => {
                if let Some(net) = self.net.as_mut().filter(|net| net.generation == generation) {
                    net.relay_wait_over = true;
                    if net.circuit.is_none() {
                        net.relay = RelayStatus::LocalOnly;
                    }
                    self.ensure_offer();
                }
            }
        }
    }

    /// Applies one poll: the transition table while pairing or enrolling, the removal check
    /// once linked.
    fn observed(&mut self, observation: &Observation) {
        let result = match self.state.clone() {
            State::Linked(identity) => {
                if !enrollment::revoked(identity.qid, observation) {
                    return;
                }
                // Record the revocation first: a crash before the key is gone still lands on
                // Revoked, and the leftover key is deleted when the user starts over.
                self.stop_node();
                self.store()
                    .revoke(&identity.handle)
                    .map_err(|e| e.to_string())
                    .and_then(|()| self.keys.delete().map_err(|e| e.to_string()))
                    .map(|()| State::Revoked(identity.handle))
            }
            state @ (State::Pairing(_) | State::AwaitingEnrollment { .. }) => {
                let identity = state.identity().cloned().expect("pairing has an identity");
                let deadline = state.approval().map(|approval| approval.intent.deadline);
                match enrollment::decide(identity.qid, deadline, observation) {
                    Next::Wait(progress) => return self.progress = progress,
                    Next::Link => {
                        let identity = Identity {
                            linked: true,
                            ..identity
                        };
                        let store = self.store();
                        store
                            .save_identity(&identity)
                            .and_then(|()| store.clear_approval())
                            .map_err(|e| e.to_string())
                            .map(|()| State::Linked(identity))
                    }
                    Next::Release => self
                        .store()
                        .clear_approval()
                        .map_err(|e| e.to_string())
                        .map(|()| State::Pairing(identity)),
                    Next::Rotate => self.rotate(identity),
                }
            }
            _ => return,
        };
        match result {
            Ok(state) => self.enter(state),
            Err(error) => eprintln!("qop: {error}"),
        }
    }

    /// The key was added and later removed, so it can never return: pair again with a new one.
    fn rotate(&mut self, identity: Identity) -> Result<State, String> {
        eprintln!(
            "qop: device key {} was removed from @{}; generating a new one",
            identity.fingerprint(),
            identity.handle
        );
        self.stop_node();
        let secret = self.new_key()?;
        let identity = Identity {
            device_key: device_key_from_secret(secret),
            linked: false,
            ..identity
        };
        let store = self.store();
        store
            .save_identity(&identity)
            .and_then(|()| store.clear_approval())
            .map_err(|e| e.to_string())?;
        Ok(State::Pairing(identity))
    }

    /// A pairing stream finished: follow whatever it did to the stored approval.
    fn pairing_done(&mut self) {
        let approval = match self.store().approval() {
            Ok(approval) => approval,
            Err(error) => return eprintln!("qop: {error}"),
        };
        match (self.state.clone(), approval) {
            (State::Pairing(identity), Some(approval)) => {
                self.progress = EnrollmentProgress::Approved;
                // Keep the session that saved it: the phone may replay if it lost the reply.
                if let Some(net) = &mut self.net {
                    net.offer = None;
                }
                self.state = State::AwaitingEnrollment {
                    identity,
                    approval: Box::new(approval),
                    recovery: false,
                };
                self.poll();
            }
            (State::AwaitingEnrollment { identity, .. }, None) => {
                self.enter(State::Pairing(identity))
            }
            _ => {}
        }
    }

    fn node_event(&mut self, event: NodeEvent) {
        let Some(net) = &mut self.net else { return };
        match event {
            NodeEvent::RelayReserved { circuit } => {
                net.relay = RelayStatus::Connected;
                let stale = net.circuit.as_ref() != Some(&circuit);
                net.circuit = Some(circuit);
                // An offer made without this circuit is worth replacing until a phone claims it.
                let unclaimed = net
                    .session
                    .as_ref()
                    .is_some_and(|s| s.try_lock().is_ok_and(|s| !s.is_claimed()));
                if stale && unclaimed {
                    self.regenerate();
                } else {
                    self.ensure_offer();
                }
            }
            NodeEvent::RelayLost => net.relay = RelayStatus::Connecting,
            NodeEvent::InboundStream(stream) => {
                let Some(session) = net
                    .session
                    .clone()
                    .filter(|_| stream.protocol == PAIR_PROTOCOL)
                else {
                    return; // Dropping the stream resets it.
                };
                let Some(identity) = self
                    .state
                    .identity()
                    .filter(|_| !matches!(self.state, State::Linked(_)))
                else {
                    return;
                };
                let context = PairContext {
                    chain: self.chain.clone(),
                    api: self.api.clone(),
                    store: self.store.clone(),
                    qid: identity.qid,
                    chain_id: identity.chain_id,
                    registry: identity.registry,
                };
                let internal = self.internal.clone();
                tokio::spawn(async move {
                    match pairing::serve(stream, session, &context).await {
                        Ok(Some(ack)) => eprintln!("qop: pairing approval {ack:?}"),
                        Ok(None) => {}
                        Err(error) => eprintln!("qop: pairing rejected: {error:?}"),
                    }
                    let _ = internal.send(Internal::PairingDone);
                });
            }
        }
    }

    fn tick(&mut self, ticks: u32) {
        match self.state {
            State::Starting => self.resume(),
            State::Linked(_) if !ticks.is_multiple_of(LINKED_POLL_EVERY) => {}
            _ => {
                // A node that failed to start (no network yet) is retried here.
                if self.state.identity().is_some() && self.net.is_none() {
                    self.start_node();
                    self.ensure_offer();
                }
                self.poll();
            }
        }
    }

    /// Observes the chain and API off-task, unless a poll is already in flight.
    fn poll(&mut self) {
        let Some(identity) = self.state.identity() else {
            return;
        };
        if self.polling {
            return;
        }
        self.polling = true;
        let (chain, api, internal) = (self.chain.clone(), self.api.clone(), self.internal.clone());
        let (device_key, qid, approval) = (
            identity.device_key,
            identity.qid,
            self.state.approval().cloned(),
        );
        tokio::spawn(async move {
            let observation =
                enrollment::observe(&chain, &api, device_key, qid, approval.as_ref()).await;
            let digest = approval.map(|approval| approval.digest);
            let _ = internal.send(Internal::Observed {
                device_key,
                digest,
                observation,
            });
        });
    }

    fn model(&self) -> Model {
        let relay = self
            .net
            .as_ref()
            .map_or(RelayStatus::Offline, |net| net.relay);
        let offer = || self.net.as_ref().and_then(|net| net.offer.clone());
        let phase = match &self.state {
            State::Starting => Phase::Starting,
            State::Unlinked => Phase::EnterHandle(EnterHandle {
                lookup: self.lookup.clone(),
            }),
            State::Pairing(identity) => Phase::Pairing(model::Pairing {
                handle: identity.handle.clone(),
                offer: offer(),
                relay,
            }),
            State::AwaitingEnrollment {
                identity, recovery, ..
            } => Phase::AwaitingEnrollment(model::AwaitingEnrollment {
                handle: identity.handle.clone(),
                progress: self.progress,
                recovery: if *recovery { offer() } else { None },
                relay,
            }),
            State::Linked(identity) => Phase::Linked(model::Linked {
                account: model::Account {
                    handle: identity.handle.clone(),
                    peer_id: identity.peer_id(),
                    fingerprint: identity.fingerprint(),
                    data_dir: self.store().dir().to_owned(),
                },
                conversations: Vec::new(),
                messaging: Messaging::Ready,
                relay,
                new_chat: NewChat::Lookup(HandleLookup::Idle),
            }),
            State::Revoked(handle) => Phase::Revoked(model::Revoked {
                handle: handle.clone(),
            }),
        };
        Model { phase }
    }

    fn publish_model(&mut self) {
        let model = self.model();
        if self.published.as_ref() != Some(&model) {
            (self.publish)(&model);
            self.published = Some(model);
        }
    }
}

async fn next_node_event(net: &mut Option<Net>) -> Option<NodeEvent> {
    match net {
        Some(net) => net.events.recv().await,
        None => std::future::pending().await,
    }
}

fn state_name(state: &State) -> &'static str {
    match state {
        State::Starting => "Starting",
        State::Unlinked => "Unlinked",
        State::Pairing(_) => "Pairing",
        State::AwaitingEnrollment { .. } => "AwaitingEnrollment",
        State::Linked(_) => "Linked",
        State::Revoked(_) => "Revoked",
    }
}
