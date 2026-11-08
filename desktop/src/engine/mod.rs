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
//! Linked, the engine also runs messaging ([`chat`], [`outbox`]) and serves the phone's
//! `/qop/sync/1` ([`sync`]), gated by [`auth::Auth`]: nothing in or out until this device's own
//! membership read succeeds (`Messaging::Ready`). A failed or stale read, a sleep/wake
//! ([`lifecycle`]), or a peer refusing us pauses messaging (`Messaging::Verifying`) and reads it
//! again; only a read showing the key removed revokes.
//!
//! Messages live in the store. The engine keeps the newest [`PAGE`] messages of each
//! conversation in memory and, after a change, reloads only the conversation it touched; a
//! published model shares each conversation's messages, so publishing copies none.

pub mod auth;
pub mod chat;
pub mod enrollment;
pub mod lifecycle;
pub mod outbox;
pub mod pairing;
pub mod sync;
#[cfg(test)]
pub(crate) mod testing;
#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use alloy_primitives::{B256, U256};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

use crate::api::ApiClient;
use crate::config::Config;
use crate::keys::{KeyStore, random_32};
use crate::model::{
    self, Command, ConversationId, Direction, EnrollmentProgress, EnterHandle, HandleLookup,
    LookupError, Message, MessageId, MessageStatus, Messaging, Model, NewChat, Offer, Phase,
    RelayStatus, Unreachable,
};
use crate::node::{Node, NodeConfig, NodeEvent};
use crate::rpc::{Account, ReadError, RegistryReader};
use crate::store::{Identity, Store};
use crate::wire::{
    CHAT_PROTOCOL, ChatFrame, DeviceActionApproval, DeviceActionStatus, DeviceActionStatusError,
    OutboxStatus, PAIR_PROTOCOL, SYNC_PROTOCOL, device_key_from_peer_id, device_key_from_secret,
};
use auth::{Auth, SelfVerdict};
use chat::ChatContext;
use enrollment::{Next, Observation};
use lifecycle::{Clock, SystemClock};
use pairing::{PairContext, PairingSession};

/// How often a pairing or enrolling device polls the API and the chain (`pollEnrollmentState`).
const POLL: Duration = Duration::from_secs(2);
/// A linked device re-reads its own membership every this many polls.
const LINKED_POLL_EVERY: u32 = 30;
/// How long pairing waits for a relay reservation before offering LAN addresses only.
const RELAY_WAIT: Duration = Duration::from_secs(15);
const AGENT_VERSION: &str = concat!("qop-desktop/", env!("CARGO_PKG_VERSION"));
/// Messages per conversation held in memory at first; each Load earlier adds as many again.
pub const PAGE: usize = 200;

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
    /// The account `device_key` is an active member of, with the head it was read at.
    fn lookup_device_key(
        &self,
        device_key: B256,
    ) -> impl Future<Output = Result<Option<Account>, ReadError>> + Send;
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

    async fn lookup_device_key(&self, device_key: B256) -> Result<Option<Account>, ReadError> {
        let reader = self.clone();
        blocking(ReadError::Rpc, move || reader.lookup_device_key(&device_key)).await
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
/// Refuses to start on a saved identity whose key is not in `keys`, typically because
/// `QOP_KEY_STORE` changed since linking. Starting over would wipe the messages; pointing
/// `QOP_KEY_STORE` back at the key recovers. `main` checks before opening the window.
pub fn check_device_key(store: &Store, keys: &KeyStore) -> Result<(), String> {
    if store.revoked().map_err(|e| e.to_string())?.is_some() {
        return Ok(());
    }
    match store.identity().map_err(|e| e.to_string())? {
        Some(identity) if keys.load().map_err(|e| e.to_string())?.is_none() => {
            Err(missing_key(&identity, keys))
        }
        _ => Ok(()),
    }
}

fn missing_key(identity: &Identity, keys: &KeyStore) -> String {
    format!(
        "the device key for @{} is not in {keys}; if QOP_KEY_STORE changed since linking, set it back",
        identity.handle
    )
}

pub fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// Wall-clock milliseconds, as messages and the outbox count them.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
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
    /// A linked device's read of its own membership; `round` names the verification it
    /// answers, so a pause that came in meanwhile asks again.
    SelfChecked {
        device_key: B256,
        round: u64,
        account: Result<Option<Account>, ReadError>,
        removed: Option<bool>,
    },
    /// A New chat lookup finished.
    ChatResolved {
        handle: String,
        result: Result<Option<Account>, ReadError>,
    },
    /// An inbound message was saved (acknowledged, unless the ACK could not be written).
    Received(chat::Received),
    /// An outbox record to `qid` changed.
    OutboxChanged { qid: String },
    /// The phone handed off a message to `qid`; it is in the outbox now.
    HandedOff { qid: String },
    /// A recipient's deliveries finished; `pause` if one of them should pause messaging.
    Delivered { qid: String, pause: bool },
    /// Something chat saw calls our own membership into question.
    Pause,
    /// A device of account `qid` connected: deliver to it now, whatever the backoff.
    PeerOnline { qid: String },
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
    /// Live authorization and the messaging gate, shared with chat tasks.
    auth: Arc<Auth>,
    messaging: Messaging,
    /// The head of the last successful own-membership read.
    self_block: Option<u64>,
    /// Bumped by every pause; a self check answers only the round it was started in.
    verify_round: u64,
    /// Invalidations [`Auth::observe`] has reported so far.
    invalidations: u64,
    conversations: Vec<model::Conversation>,
    /// How many messages each conversation (by QID) holds when more than [`PAGE`].
    windows: HashMap<String, usize>,
    /// What the last poll could not reach.
    trouble: Option<Unreachable>,
    /// The conversation last opened; what arrives there is read at once.
    active: Option<ConversationId>,
    new_chat: NewChat,
    /// Recipients (QIDs) with a delivery task running.
    delivering: HashSet<String>,
    inbound: Arc<AtomicUsize>,
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
            auth: Arc::new(Auth::new(Arc::new(SystemClock::default()) as Arc<dyn Clock>)),
            messaging: Messaging::Verifying,
            self_block: None,
            verify_round: 0,
            invalidations: 0,
            conversations: Vec::new(),
            windows: HashMap::new(),
            trouble: None,
            active: None,
            new_chat: NewChat::Lookup(HandleLookup::Idle),
            delivering: HashSet::new(),
            inbound: Arc::default(),
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
        let mut observe = tokio::time::interval(lifecycle::OBSERVE_EVERY);
        observe.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
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
                _ = observe.tick() => self.observe_lifecycle(),
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
            return Err(missing_key(&identity, &self.keys));
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
        // Linked starts paused: messaging waits for this device's own membership read.
        self.set_messaging(Messaging::Verifying);
        self.self_block = None;
        self.trouble = None;
        self.active = None;
        self.windows.clear();
        self.new_chat = NewChat::Lookup(HandleLookup::Idle);
        self.reload();
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
            // Registered up front: the endpoint negotiates only these, outbound included.
            protocols: vec![
                PAIR_PROTOCOL.into(),
                CHAT_PROTOCOL.into(),
                SYNC_PROTOCOL.into(),
            ],
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
        // Connection ids mean nothing without the node; nor does what was authorized on them.
        self.auth.clear();
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
            (Command::OpenConversation(id), State::Linked(_)) => {
                if let Err(error) = self.store().mark_read(&id.0) {
                    eprintln!("qop: {error}");
                }
                self.refresh(&id.0);
                self.active = Some(id);
            }
            (Command::LoadEarlier(id), State::Linked(_)) => {
                let shown = self.conversation(&id.0).map_or(0, |c| c.messages.len());
                if self.conversation(&id.0).is_some_and(|c| c.earlier) {
                    self.windows.insert(id.0.clone(), shown + PAGE);
                    self.refresh(&id.0);
                }
            }
            (Command::StartChat(handle), State::Linked(_)) => self.start_chat(handle),
            (Command::Send { conversation, text }, State::Linked(identity)) => {
                let from = identity.handle.clone();
                self.send(&conversation, from, text);
            }
            (Command::Retry(id), State::Linked(_)) => self.retry(&id),
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

    /// The identity goes before the key: a crash between them leaves a key, which the next link
    /// adopts, never an identity without its key (which startup refuses).
    fn unlink(&mut self) {
        self.stop_node();
        let result = self
            .store()
            .delete_identity()
            .map_err(|e| e.to_string())
            .and_then(|()| self.keys.delete().map_err(|e| e.to_string()));
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
            Internal::SelfChecked {
                device_key,
                round,
                account,
                removed,
            } => {
                self.polling = false;
                // An invalidation a chat task consumed meanwhile starts a new round first, so
                // a read begun before it cannot resume messaging.
                self.observe_lifecycle();
                self.self_checked(device_key, round, &account, removed);
            }
            Internal::ChatResolved { handle, result } => self.chat_resolved(handle, result),
            Internal::Received(received) => {
                if received.inserted {
                    if self.active.as_ref().is_some_and(|id| id.0 == received.from_qid) {
                        let _ = self.store().mark_read(&received.from_qid);
                    }
                    self.refresh(&received.from_qid);
                }
                // They are online: whatever we have queued for them can go now.
                self.flush(Some(&received.from_qid));
            }
            Internal::OutboxChanged { qid } => self.refresh(&qid),
            Internal::HandedOff { qid } => {
                self.refresh(&qid);
                self.flush(None);
            }
            Internal::Delivered { qid, pause } => {
                self.delivering.remove(&qid);
                if pause {
                    self.pause();
                }
            }
            Internal::Pause => self.pause(),
            Internal::PeerOnline { qid } => self.flush(Some(&qid)),
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
            state @ (State::Pairing(_) | State::AwaitingEnrollment { .. }) => {
                let identity = state.identity().cloned().expect("pairing has an identity");
                let deadline = state.approval().map(|approval| approval.intent.deadline);
                self.trouble = if observation.membership.is_err() {
                    Some(Unreachable::Chain)
                } else if state.approval().is_some()
                    && observation.api == enrollment::ApiLookup::Unknown
                {
                    Some(Unreachable::Api)
                } else {
                    None
                };
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
                    Next::Release => {
                        let store = self.store();
                        match store.approval() {
                            // Pairing saved a replacement since this poll began: keep it
                            // (its `PairingDone` adopts it).
                            Ok(Some(saved))
                                if state.approval().is_some_and(|a| a.digest != saved.digest) =>
                            {
                                return;
                            }
                            Ok(_) => store
                                .clear_approval()
                                .map_err(|e| e.to_string())
                                .map(|()| State::Pairing(identity)),
                            Err(error) => Err(error.to_string()),
                        }
                    }
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

    /// Removed from the account (affirmative chain evidence): wipe the key and messages.
    fn revoke(&mut self, identity: Identity) {
        // Record the revocation first: a crash before the key is gone still lands on Revoked,
        // and the leftover key is deleted when the user starts over. Likewise if deleting it
        // fails now: the store already says Revoked, so the UI must too.
        self.stop_node();
        if let Err(error) = self.store().revoke(&identity.handle) {
            return eprintln!("qop: {error}");
        }
        if let Err(error) = self.keys.delete() {
            eprintln!("qop: {error}");
        }
        self.enter(State::Revoked(identity.handle));
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

    /// A pairing stream finished: follow whatever it did to the stored approval, including a
    /// replacement saved on the recovery offer after the old one stopped occupying the slot.
    fn pairing_done(&mut self) {
        let approval = match self.store().approval() {
            Ok(approval) => approval,
            Err(error) => return eprintln!("qop: {error}"),
        };
        let held = self.state.approval().map(|approval| approval.digest);
        match (self.state.clone(), approval) {
            (
                State::Pairing(identity) | State::AwaitingEnrollment { identity, .. },
                Some(approval),
            ) if held != Some(approval.digest) => {
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
            NodeEvent::ConnectionEstablished { conn, peer } => {
                self.auth.opened(conn, &peer);
                self.peer_connected(&peer);
            }
            NodeEvent::ConnectionClosed { conn, peer } => self.auth.closed(conn, &peer),
            NodeEvent::InboundStream(stream) if stream.protocol == CHAT_PROTOCOL => {
                self.inbound_chat(stream);
            }
            NodeEvent::InboundStream(stream) if stream.protocol == SYNC_PROTOCOL => {
                self.inbound_sync(stream);
            }
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
            State::Linked(_) => {
                if self.net.is_none() {
                    self.start_node();
                }
                // Paused: read again every tick. Ready: once a minute.
                if self.messaging == Messaging::Verifying || ticks.is_multiple_of(LINKED_POLL_EVERY)
                {
                    self.poll();
                }
                self.flush(None);
            }
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
        if let State::Linked(identity) = &self.state {
            let (chain, internal) = (self.chain.clone(), self.internal.clone());
            let (device_key, qid, round) = (identity.device_key, identity.qid, self.verify_round);
            tokio::spawn(async move {
                let account = chain.lookup_device_key(device_key).await;
                // The removal marker matters only when the key is not an active member.
                let removed = match &account {
                    Ok(Some(account)) if account.qid == qid => None,
                    Ok(_) => chain.key_removed(device_key).await.ok(),
                    Err(_) => None,
                };
                let _ = internal.send(Internal::SelfChecked {
                    device_key,
                    round,
                    account,
                    removed,
                });
            });
            return;
        }
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

    fn set_messaging(&mut self, messaging: Messaging) {
        self.messaging = messaging;
        self.auth.set_ready(messaging == Messaging::Ready);
    }

    /// Stops messaging until a fresh read of our own membership succeeds. Never wipes.
    fn pause(&mut self) {
        if !matches!(self.state, State::Linked(_)) {
            return;
        }
        self.verify_round += 1;
        self.set_messaging(Messaging::Verifying);
        self.poll();
    }

    /// The once-a-second clock check: a sleep, stall or clock step pauses messaging.
    fn observe_lifecycle(&mut self) {
        let invalidations = self.auth.observe();
        if invalidations != self.invalidations {
            self.invalidations = invalidations;
            self.pause();
        }
    }

    fn self_checked(
        &mut self,
        device_key: B256,
        round: u64,
        account: &Result<Option<Account>, ReadError>,
        removed: Option<bool>,
    ) {
        let State::Linked(identity) = &self.state else {
            return;
        };
        if identity.device_key != device_key {
            return;
        }
        if round != self.verify_round {
            return self.poll();
        }
        self.trouble = matches!(account, Err(ReadError::Rpc)).then_some(Unreachable::Chain);
        match auth::judge_self(identity.qid, account, removed, self.self_block) {
            SelfVerdict::Member(block) => {
                self.self_block = Some(block);
                self.set_messaging(Messaging::Ready);
                self.flush(None);
            }
            SelfVerdict::Removed => self.revoke(identity.clone()),
            SelfVerdict::Unverified => self.set_messaging(Messaging::Verifying),
        }
    }

    /// What chat tasks need, while linked with a running node.
    fn chat_context(&self) -> Option<ChatContext<C>> {
        let net = self.net.as_ref()?;
        matches!(self.state, State::Linked(_)).then(|| ChatContext {
            node: net.node.handle(),
            auth: self.auth.clone(),
            chain: self.chain.clone(),
            store: self.store.clone(),
        })
    }

    /// A context for one more inbound stream, while messaging is ready and under the limit
    /// chat and sync share; `None` drops the stream, which resets it, and the sender retries.
    fn inbound_slot(&self) -> Option<(ChatContext<C>, InboundSlot)> {
        let ctx = self
            .chat_context()
            .filter(|_| self.messaging == Messaging::Ready)?;
        if self.inbound.fetch_add(1, Ordering::SeqCst) >= chat::MAX_INBOUND_STREAMS {
            self.inbound.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        Some((ctx, InboundSlot(self.inbound.clone())))
    }

    /// Serves an inbound chat stream.
    fn inbound_chat(&mut self, stream: crate::node::Stream) {
        let Some((ctx, slot)) = self.inbound_slot() else {
            return;
        };
        let internal = self.internal.clone();
        tokio::spawn(async move {
            let _slot = slot;
            match chat::serve_inbound(stream, &ctx, now_ms).await {
                Ok(received) => {
                    let _ = internal.send(Internal::Received(received));
                }
                Err(chat::InboundError::Unverified(error)) if error.pauses() => {
                    eprintln!("qop: inbound chat not verified: {error:?}");
                    let _ = internal.send(Internal::Pause);
                }
                Err(error) => eprintln!("qop: inbound chat dropped: {error:?}"),
            }
        });
    }

    /// Serves an inbound `/qop/sync/1` stream from (we verify) one of our own devices.
    fn inbound_sync(&mut self, stream: crate::node::Stream) {
        let State::Linked(identity) = &self.state else {
            return;
        };
        let own = sync::Own {
            handle: identity.handle.clone(),
            qid: identity.qid,
        };
        let Some((ctx, slot)) = self.inbound_slot() else {
            return;
        };
        let internal = self.internal.clone();
        tokio::spawn(async move {
            let _slot = slot;
            match sync::serve(stream, &ctx, &own).await {
                Ok(sync::Served::Held { to_qid }) => {
                    let _ = internal.send(Internal::HandedOff { qid: to_qid });
                }
                Ok(sync::Served::Answered) => {}
                Err(sync::SyncError::Unverified(error)) if error.pauses() => {
                    eprintln!("qop: sync peer not verified: {error:?}");
                    let _ = internal.send(Internal::Pause);
                }
                Err(error) => eprintln!("qop: sync stream dropped: {error:?}"),
            }
        });
    }

    /// A peer connected: if it is a device of someone we have queued messages for, deliver now
    /// (`outbox.wake`).
    fn peer_connected(&mut self, peer: &minip2p::PeerId) {
        if self.messaging != Messaging::Ready
            || !self.store().queued().is_ok_and(|queued| !queued.is_empty())
        {
            return;
        }
        let Some(device_key) = device_key_from_peer_id(&peer.to_base58()) else {
            return;
        };
        let (chain, internal) = (self.chain.clone(), self.internal.clone());
        tokio::spawn(async move {
            if let Ok(Some(account)) = chain.lookup_device_key(device_key).await {
                let qid = account.qid.to_string();
                let _ = internal.send(Internal::PeerOnline { qid });
            }
        });
    }

    /// Starts delivery of every due queued record, one task per recipient not already being
    /// delivered to; `now_for` ignores the backoff for that recipient.
    fn flush(&mut self, now_for: Option<&str>) {
        if self.messaging != Messaging::Ready {
            return;
        }
        let Some(ctx) = self.chat_context() else {
            return;
        };
        let queued = match self.store().queued() {
            Ok(queued) => queued,
            Err(error) => return eprintln!("qop: {error}"),
        };
        let now = now_ms();
        let mut due: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for record in queued {
            if (record.next_attempt_at <= now || now_for == Some(record.to_qid.as_str()))
                && !self.delivering.contains(&record.to_qid)
            {
                due.entry(record.to_qid).or_default().push(record.frame.id);
            }
        }
        for (qid, ids) in due {
            if self.delivering.len() >= outbox::FLUSH_CONCURRENCY {
                break;
            }
            self.delivering.insert(qid.clone());
            let (ctx, internal) = (ctx.clone(), self.internal.clone());
            tokio::spawn(async move {
                let mut pause = false;
                for id in ids {
                    match outbox::deliver_one(&ctx, &id, now_ms).await {
                        Ok(outbox::Outcome::Waiting { pauses }) => pause |= pauses,
                        Ok(_) => {}
                        Err(error) => eprintln!("qop: outbox: {error}"),
                    }
                    let qid = qid.clone();
                    let _ = internal.send(Internal::OutboxChanged { qid });
                }
                let _ = internal.send(Internal::Delivered { qid, pause });
            });
        }
    }

    /// New chat: resolve the handle on chain, off-task.
    fn start_chat(&mut self, handle: String) {
        if crate::registry::handle_hash(&handle).is_err() {
            self.new_chat = NewChat::Lookup(HandleLookup::Failed {
                handle,
                error: LookupError::Invalid,
            });
            return;
        }
        self.new_chat = NewChat::Lookup(HandleLookup::Resolving {
            handle: handle.clone(),
        });
        let (chain, internal) = (self.chain.clone(), self.internal.clone());
        tokio::spawn(async move {
            let result = chain.lookup_handle(handle.clone()).await;
            let _ = internal.send(Internal::ChatResolved { handle, result });
        });
    }

    fn chat_resolved(&mut self, handle: String, result: Result<Option<Account>, ReadError>) {
        if !matches!(&self.new_chat, NewChat::Lookup(HandleLookup::Resolving { handle: h }) if *h == handle)
        {
            return;
        }
        let failed = |error| NewChat::Lookup(HandleLookup::Failed {
            handle: handle.clone(),
            error,
        });
        self.new_chat = match result {
            Ok(Some(account)) => {
                let qid = account.qid.to_string();
                let saved = self.store().upsert_contact(&qid, &account.handle);
                if let Err(error) = saved {
                    eprintln!("qop: {error}");
                    self.new_chat = failed(LookupError::Unreachable);
                    return;
                }
                self.refresh(&qid);
                NewChat::Resolved {
                    handle,
                    conversation: ConversationId(qid),
                }
            }
            Ok(None) => failed(LookupError::NotFound),
            Err(ReadError::InvalidHandle) => failed(LookupError::Invalid),
            Err(_) => failed(LookupError::Unreachable),
        };
    }

    /// Composer Send: save the message `queued`, then try to deliver it.
    fn send(&mut self, conversation: &ConversationId, from_handle: String, text: String) {
        let handle = match self.store().contact(&conversation.0) {
            Ok(Some(handle)) => handle,
            other => return eprintln!("qop: no conversation {conversation:?}: {other:?}"),
        };
        let now = now_ms();
        let frame = ChatFrame {
            from_handle,
            id: outbox::new_message_id(),
            sent_at: now,
            text,
        };
        if let Err(error) = frame.encode() {
            return eprintln!("qop: message not sendable: {error:?}");
        }
        let record = outbox::new_record(frame, &handle, &conversation.0, now);
        if let Err(error) = self.store().enqueue(&record) {
            return eprintln!("qop: {error}");
        }
        self.refresh(&conversation.0);
        self.flush(None);
    }

    /// Retry: a failed message is queued again; a queued one is tried now.
    fn retry(&mut self, id: &MessageId) {
        let record = match self.store().outbox(&id.0) {
            Ok(Some(record)) => record,
            other => return eprintln!("qop: no message {id:?}: {other:?}"),
        };
        if record.status == OutboxStatus::Failed {
            let retried = outbox::retried(&record, now_ms());
            if let Err(error) = self.store().put(&retried) {
                return eprintln!("qop: {error}");
            }
            self.refresh(&record.to_qid);
        }
        self.flush(Some(&record.to_qid));
    }

    /// Rebuilds the conversation list from the store (empty unless linked).
    fn reload(&mut self) {
        self.conversations = if matches!(self.state, State::Linked(_)) {
            match conversations(&self.store(), &self.windows) {
                Ok(conversations) => conversations,
                Err(error) => return eprintln!("qop: {error}"),
            }
        } else {
            Vec::new()
        };
    }

    /// Reloads the one conversation with `qid` (adding it if new) and re-sorts the list.
    fn refresh(&mut self, qid: &str) {
        if !matches!(self.state, State::Linked(_)) {
            return;
        }
        let loaded = {
            let store = self.store();
            store.contact_summary(qid).and_then(|contact| {
                contact
                    .map(|contact| conversation(&store, contact, &self.windows))
                    .transpose()
            })
        };
        let fresh = match loaded {
            Ok(Some(fresh)) => fresh,
            Ok(None) => return,
            Err(error) => return eprintln!("qop: {error}"),
        };
        match self.conversations.iter_mut().find(|c| c.id.0 == qid) {
            Some(slot) => *slot = fresh,
            None => self.conversations.push(fresh),
        }
        sort_conversations(&mut self.conversations);
    }

    fn conversation(&self, qid: &str) -> Option<&model::Conversation> {
        self.conversations.iter().find(|c| c.id.0 == qid)
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
                trouble: self.trouble,
            }),
            State::Linked(identity) => Phase::Linked(model::Linked {
                account: model::Account {
                    handle: identity.handle.clone(),
                    peer_id: identity.peer_id(),
                    fingerprint: identity.fingerprint(),
                    data_dir: self.store().dir().to_owned(),
                },
                conversations: self.conversations.clone(),
                messaging: self.messaging,
                relay,
                trouble: self.trouble,
                new_chat: self.new_chat.clone(),
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

/// What a linked data directory holds, as the model the UI renders: for headless renders of a
/// real run (the `live` scene). Connectivity is not stored; it shows as ready.
pub fn stored_model(dir: &std::path::Path) -> Option<Model> {
    let store = Store::open(dir).ok()?;
    let identity = store.identity().ok()?.filter(|identity| identity.linked)?;
    Some(Model {
        phase: Phase::Linked(model::Linked {
            account: model::Account {
                handle: identity.handle.clone(),
                peer_id: identity.peer_id(),
                fingerprint: identity.fingerprint(),
                data_dir: dir.to_owned(),
            },
            conversations: conversations(&store, &HashMap::new()).ok()?,
            messaging: Messaging::Ready,
            relay: RelayStatus::Connected,
            trouble: None,
            new_chat: NewChat::Lookup(HandleLookup::Idle),
        }),
    })
}

/// Every conversation with its newest messages (`windows`, else [`PAGE`]), most recently active
/// first.
fn conversations(
    store: &Store,
    windows: &HashMap<String, usize>,
) -> Result<Vec<model::Conversation>, crate::store::StoreError> {
    let mut conversations = store
        .contacts()?
        .into_iter()
        .map(|contact| conversation(store, contact, windows))
        .collect::<Result<Vec<_>, _>>()?;
    sort_conversations(&mut conversations);
    Ok(conversations)
}

/// One conversation as the model shows it.
fn conversation(
    store: &Store,
    contact: crate::store::Contact,
    windows: &HashMap<String, usize>,
) -> Result<model::Conversation, crate::store::StoreError> {
    let window = windows.get(&contact.qid).copied().unwrap_or(PAGE);
    let (rows, earlier) = store.thread(&contact.qid, window)?;
    let messages = rows
        .into_iter()
        .map(|row| Message {
            id: MessageId(row.id),
            direction: match row.sent {
                None => Direction::Received,
                Some(OutboxStatus::Queued) => Direction::Sent(MessageStatus::Queued),
                Some(OutboxStatus::Sent) => Direction::Sent(MessageStatus::Sent),
                Some(OutboxStatus::Failed) => Direction::Sent(MessageStatus::Failed),
            },
            text: row.text,
            at: UNIX_EPOCH + Duration::from_millis(row.at_ms),
        })
        .collect();
    Ok(model::Conversation {
        id: ConversationId(contact.qid),
        peer: contact.handle,
        unread: contact.unread,
        messages,
        earlier,
    })
}

/// Most recently active first; a chat with no messages yet (just started) leads.
fn sort_conversations(conversations: &mut [model::Conversation]) {
    conversations.sort_by_key(|c| std::cmp::Reverse(c.last().map_or(SystemTime::now(), |m| m.at)));
}

/// Holds one of the inbound stream slots chat and sync share; dropping it frees the slot.
struct InboundSlot(Arc<AtomicUsize>);

impl Drop for InboundSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
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
