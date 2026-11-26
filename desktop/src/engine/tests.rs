//! The engine end to end in-process: a real node on loopback, a scripted phone node speaking
//! `/qop/pair/1` (or a scripted contact speaking `/qop/chat/2`), fake chain and API, and
//! restarts over the same data directory.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use alloy_primitives::U256;
use minip2p::PeerId;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio::task::JoinHandle;

use super::auth::Auth;
use super::testing::{CHAIN_ID, FakeApi, FakeChain, QID, REGISTRY, approval_for};
use super::{Engine, Publish, chat};
use crate::config::Config;
use crate::keys::KeyStore;
use crate::model::{
    Command, Direction, EnrollmentProgress, HandleLookup, LookupError, MessageStatus, Messaging,
    Model, NewChat, Offer, Phase,
};
use crate::node::{Node, NodeConfig, NodeEvent, NodeHandle};
use crate::store::Store;
use crate::wire::{
    CHAT_PROTOCOL, ChatAck, ChatFrame, DeviceActionApproval, DeviceActionStatus,
    MAX_CHAT_PAYLOAD_BYTES, MAX_SYNC_PAYLOAD_BYTES, OutboxRecord, PAIR_PROTOCOL,
    PAIRING_FRAME_MAX_BYTES, PairingFrame, PairingOffer, SYNC_PROTOCOL, SyncErrorReason,
    SyncReceipt, SyncRequest, SyncResponse, device_key_from_secret, peer_id_from_device_key,
};

const PHONE_SECRET: [u8; 32] = [0x55; 32];
const DEADLINE: u64 = 1_700_003_600;

struct Desktop {
    models: UnboundedReceiver<Model>,
    commands: UnboundedSender<Command>,
    task: JoinHandle<()>,
    auth: Arc<Auth>,
}

impl Desktop {
    fn start(dir: &Path, chain: &FakeChain, api: &FakeApi) -> Desktop {
        Self::start_on(dir, chain, api, "/ip4/127.0.0.1/udp/0/quic-v1")
    }

    fn start_on(dir: &Path, chain: &FakeChain, api: &FakeApi, listen: &str) -> Desktop {
        Self::start_with_mailboxes(dir, chain, api, listen, vec![])
    }

    fn start_with_mailboxes(
        dir: &Path,
        chain: &FakeChain,
        api: &FakeApi,
        listen: &str,
        mailboxes: Vec<String>,
    ) -> Desktop {
        let config = Config {
            rpc_url: "http://unused".into(),
            registry: REGISTRY,
            chain_id: U256::from(CHAIN_ID),
            api_url: None,
            relays: vec![],
            mailboxes,
            listen: vec![listen.into()],
        };
        let store = Store::open(dir).expect("store");
        let keys = KeyStore::File {
            path: dir.join("device.key"),
        };
        let (sender, models) = unbounded_channel();
        let publish: Publish = Box::new(move |model: &Model| {
            let _ = sender.send(model.clone());
        });
        let engine = Engine::new(config, chain.clone(), api.clone(), store, keys, publish);
        let (commands, inbox) = unbounded_channel();
        Desktop {
            models,
            commands,
            auth: engine.auth.clone(),
            task: tokio::spawn(engine.run(inbox)),
        }
    }

    /// The next published model whose phase passes `want`.
    async fn wait_for(&mut self, what: &str, want: impl Fn(&Phase) -> bool) -> Phase {
        let wait = async {
            loop {
                let model = self.models.recv().await.expect("engine running");
                if want(&model.phase) {
                    return model.phase;
                }
            }
        };
        tokio::time::timeout(Duration::from_secs(20), wait)
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {what}"))
    }

    fn send(&self, command: Command) {
        self.commands.send(command).expect("engine running");
    }

    /// Waits until the engine has heard every connection to `peer` close. A peer that redials
    /// before then can lose minip2p's connection race to its old, still-draining connection
    /// (same direction, within the 5 s simultaneous-dial window) and see the new one closed.
    async fn wait_disconnected(&self, peer: &PeerId) {
        let wait = async {
            while self.auth.connected(peer) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        tokio::time::timeout(Duration::from_secs(20), wait)
            .await
            .expect("timed out waiting for the peer's connection to close");
    }

    /// Nothing published over a few polls says messaging is ready.
    async fn stays_paused(&mut self) {
        tokio::time::sleep(Duration::from_secs(3)).await;
        while let Ok(model) = self.models.try_recv() {
            assert!(!ready(&model.phase), "resumed while it should stay paused");
        }
    }

    async fn stop(self) {
        drop(self.commands);
        self.task.await.expect("engine exits cleanly");
    }
}

fn offer_of(phase: &Phase) -> Option<&Offer> {
    match phase {
        Phase::Pairing(pairing) => pairing.offer.as_ref(),
        Phase::AwaitingEnrollment(awaiting) => awaiting.recovery.as_ref(),
        _ => None,
    }
}

/// The phone: an active device of the account that dials the offer and speaks `/qop/pair/1`.
struct Phone {
    node: Node,
    desktop: PeerId,
    offer: PairingOffer,
}

impl Phone {
    async fn dial(code: &str) -> Phone {
        let offer = PairingOffer::decode(code, super::now_seconds()).expect("a valid offer");
        let (node, _events) = Node::start(NodeConfig {
            secret: PHONE_SECRET,
            agent_version: "phone".into(),
            protocols: vec![PAIR_PROTOCOL.into()],
            inbound_stream_limits: vec![],
            relays: vec![],
            listen: vec!["/ip4/127.0.0.1/udp/0/quic-v1".into()],
            max_unread: MAX_SYNC_PAYLOAD_BYTES,
        })
        .expect("phone node");
        let desktop = node
            .handle()
            .connect(offer.addrs.clone())
            .await
            .expect("dials the offer");
        assert_eq!(desktop, peer_id_from_device_key(&offer.device_key));
        Phone {
            node,
            desktop,
            offer,
        }
    }

    async fn exchange(&self, frame: PairingFrame) -> Option<PairingFrame> {
        exchange(&self.node.handle(), &self.desktop, frame).await
    }

    async fn hello(&self) -> Option<PairingFrame> {
        let hello = PairingFrame::Hello {
            challenge: alloy_primitives::B256::repeat_byte(0x33),
            secret: self.offer.secret,
            session_id: self.offer.session_id,
        };
        self.exchange(hello).await
    }

    async fn approve(&self, record: &DeviceActionApproval) -> Option<PairingFrame> {
        self.exchange(PairingFrame::Approval {
            record: record.clone(),
            session_id: self.offer.session_id,
        })
        .await
    }
}

/// One frame out, one back; `None` when the desktop reset the stream.
async fn exchange(node: &NodeHandle, peer: &PeerId, frame: PairingFrame) -> Option<PairingFrame> {
    let mut stream = node.open_stream(peer, PAIR_PROTOCOL).await.expect("opens");
    stream.send_message(frame.encode().unwrap()).await.ok()?;
    let reply = stream.read_to_end(PAIRING_FRAME_MAX_BYTES).await.ok()?;
    Some(PairingFrame::decode(&reply).expect("a pairing frame"))
}

fn saved(digest: alloy_primitives::B256) -> impl Fn(&Option<PairingFrame>) -> bool {
    move |reply| matches!(reply, Some(PairingFrame::ApprovalSaved { digest: d, .. }) if *d == digest)
}

fn fresh_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("qop-engine-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn phone_chain() -> FakeChain {
    let chain = FakeChain::default();
    chain.set_devices(vec![device_key_from_secret(PHONE_SECRET)]);
    chain
}

async fn pairing_offer(desktop: &mut Desktop) -> String {
    let phase = desktop
        .wait_for(
            "a pairing offer",
            |phase| matches!(phase, Phase::Pairing(p) if p.offer.is_some()),
        )
        .await;
    offer_of(&phase).expect("offer").code.clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn pairs_survives_restarts_and_links_on_its_own_chain_read() {
    let dir = fresh_dir("link");
    let (chain, api) = (phone_chain(), FakeApi::status(DeviceActionStatus::Ready));
    let mut desktop = Desktop::start(&dir, &chain, &api);
    desktop
        .wait_for("the handle form", |phase| {
            matches!(phase, Phase::EnterHandle(_))
        })
        .await;
    desktop.send(Command::SubmitHandle("alice".into()));

    // Phone: hello, then the owner-signed approval; the desktop saves it before acking.
    let phone = Phone::dial(&pairing_offer(&mut desktop).await).await;
    let device_key = phone.offer.device_key;
    assert!(
        matches!(phone.hello().await, Some(PairingFrame::HelloAck { device_key: k, .. }) if k == device_key)
    );
    let record = approval_for(device_key, 9, DEADLINE, 1);
    assert!(saved(record.digest)(&phone.approve(&record).await));
    desktop
        .wait_for(
            "enrollment",
            |phase| matches!(phase, Phase::AwaitingEnrollment(a) if a.recovery.is_none()),
        )
        .await;

    // The phone lost approvalSaved: the same record replays it; a different one conflicts.
    assert!(saved(record.digest)(&phone.approve(&record).await));
    let other = approval_for(device_key, 10, DEADLINE, 1);
    assert!(
        matches!(phone.approve(&other).await, Some(PairingFrame::ApprovalConflict { digest, .. }) if digest == record.digest)
    );
    drop(phone);

    // Restart mid-enrollment: the approval is still pending, progress follows the API.
    desktop.stop().await;
    api.set(Ok(DeviceActionStatus::Submitted));
    let mut desktop = Desktop::start(&dir, &chain, &api);
    desktop
        .wait_for("resumed enrollment", |phase| {
            matches!(phase, Phase::AwaitingEnrollment(a) if a.progress == EnrollmentProgress::Submitted)
        })
        .await;

    // Stop waiting shows a recovery offer for the same key; the phone replays its record there.
    desktop.send(Command::StopWaiting);
    let phase = desktop
        .wait_for("a recovery offer", |phase| offer_of(phase).is_some())
        .await;
    let phone = Phone::dial(&offer_of(&phase).unwrap().code).await;
    assert_eq!(phone.offer.device_key, device_key);
    assert!(phone.hello().await.is_some());
    assert!(saved(record.digest)(&phone.approve(&record).await));

    // Linked only once its own chain read shows the key.
    chain.set_membership(Some(QID));
    let linked = desktop
        .wait_for("linked", |phase| matches!(phase, Phase::Linked(_)))
        .await;
    let peer_id = peer_id_from_device_key(&device_key).to_base58();
    assert!(
        matches!(&linked, Phase::Linked(l) if l.account.peer_id == peer_id && l.account.data_dir == dir)
    );
    desktop.stop().await;

    // And it comes back linked, with the same identity.
    let mut desktop = Desktop::start(&dir, &chain, &api);
    let linked = desktop
        .wait_for("linked after restart", |phase| {
            matches!(phase, Phase::Linked(_))
        })
        .await;
    assert!(matches!(&linked, Phase::Linked(l) if l.account.peer_id == peer_id));
    desktop.stop().await;

    // Removed on chain: a failed read changes nothing, the registry's marker revokes.
    chain.set_membership(None);
    chain.set_removed(Err(crate::rpc::ReadError::Rpc));
    let mut desktop = Desktop::start(&dir, &chain, &api);
    desktop
        .wait_for("linked", |phase| matches!(phase, Phase::Linked(_)))
        .await;
    // The startup poll has answered by now; the key and identity are untouched.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(dir.join("device.key").exists());
    desktop.stop().await;
    chain.set_removed(Ok(true));
    let mut desktop = Desktop::start(&dir, &chain, &api);
    desktop
        .wait_for(
            "revoked",
            |phase| matches!(phase, Phase::Revoked(r) if r.handle == "alice"),
        )
        .await;
    assert!(!dir.join("device.key").exists());
    // A key whose deletion failed is deleted again when the revoked device starts.
    desktop.stop().await;
    let keys = KeyStore::File {
        path: dir.join("device.key"),
    };
    keys.save(&[0x11; 32]).unwrap();
    let mut desktop = Desktop::start(&dir, &chain, &api);
    desktop
        .wait_for("revoked", |phase| matches!(phase, Phase::Revoked(_)))
        .await;
    assert!(!dir.join("device.key").exists());
    desktop.send(Command::AcknowledgeRevoked);
    desktop
        .wait_for("a fresh start", |phase| {
            matches!(phase, Phase::EnterHandle(_))
        })
        .await;
    // Linking again pairs with a new key: the removed one can never return.
    chain.set_removed(Ok(false));
    desktop.send(Command::SubmitHandle("alice".into()));
    let code = pairing_offer(&mut desktop).await;
    let fresh = PairingOffer::decode(&code, super::now_seconds()).unwrap().device_key;
    assert_ne!(fresh, device_key);
    assert!(dir.join("device.key").exists());
    desktop.stop().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn releases_expired_approvals_and_rotates_removed_keys() {
    let dir = fresh_dir("release");
    let (chain, api) = (phone_chain(), FakeApi::status(DeviceActionStatus::Ready));
    let mut desktop = Desktop::start(&dir, &chain, &api);
    desktop.send(Command::SubmitHandle("alice".into()));
    let phone = Phone::dial(&pairing_offer(&mut desktop).await).await;
    let first_key = phone.offer.device_key;
    phone.hello().await.expect("hello");
    let record = approval_for(first_key, 9, DEADLINE, 1);
    assert!(saved(record.digest)(&phone.approve(&record).await));
    desktop
        .wait_for("enrollment", |phase| {
            matches!(phase, Phase::AwaitingEnrollment(_))
        })
        .await;

    // Expired: back to pairing with the same key, so the phone may sign a replacement.
    api.set(Ok(DeviceActionStatus::Expired));
    let code = pairing_offer(&mut desktop).await;
    assert_eq!(
        PairingOffer::decode(&code, super::now_seconds())
            .unwrap()
            .device_key,
        first_key
    );

    // A removed key can never return: a fresh one is generated.
    chain.set_removed(Ok(true));
    let rotated = desktop
        .wait_for("a new key", |phase| {
            offer_of(phase)
                .is_some_and(|o| PairingOffer::decode(&o.code, 0).unwrap().device_key != first_key)
        })
        .await;
    assert!(matches!(rotated, Phase::Pairing(_)));
    desktop.stop().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_replacement_saved_during_recovery_is_followed() {
    let dir = fresh_dir("replace");
    let (chain, api) = (phone_chain(), FakeApi::status(DeviceActionStatus::Ready));
    let mut desktop = Desktop::start(&dir, &chain, &api);
    desktop.send(Command::SubmitHandle("alice".into()));
    let phone = Phone::dial(&pairing_offer(&mut desktop).await).await;
    let device_key = phone.offer.device_key;
    phone.hello().await.expect("hello");
    let first = approval_for(device_key, 9, DEADLINE, 1);
    assert!(saved(first.digest)(&phone.approve(&first).await));
    desktop
        .wait_for("enrollment", |phase| {
            matches!(phase, Phase::AwaitingEnrollment(_))
        })
        .await;

    // The first approval's deadline passes while our own polls cannot read membership (so they
    // wait); the phone signs a replacement on the recovery offer, which releases the first.
    chain.fail_membership();
    api.set(Err(crate::wire::DeviceActionStatusError::Missing));
    chain.set_time(DEADLINE + 1);
    desktop.send(Command::StopWaiting);
    let phase = desktop
        .wait_for("a recovery offer", |phase| offer_of(phase).is_some())
        .await;
    // The same phone, still connected, scans it.
    let offer = PairingOffer::decode(&offer_of(&phase).unwrap().code, super::now_seconds());
    let phone = Phone {
        offer: offer.expect("a valid offer"),
        ..phone
    };
    phone.hello().await.expect("hello");
    let second = approval_for(device_key, 9, DEADLINE + 300, 1);
    assert!(saved(second.digest)(&phone.approve(&second).await));

    // The desktop waits on the replacement, and polls no longer release it.
    desktop
        .wait_for(
            "enrollment on the replacement",
            |phase| matches!(phase, Phase::AwaitingEnrollment(a) if a.recovery.is_none()),
        )
        .await;
    chain.set_membership(None);
    tokio::time::sleep(Duration::from_secs(3)).await;
    while let Ok(model) = desktop.models.try_recv() {
        assert!(matches!(model.phase, Phase::AwaitingEnrollment(_)));
    }
    desktop.stop().await;
    std::fs::remove_dir_all(dir).unwrap();
}

fn failed(phase: &Phase, error: LookupError) -> bool {
    matches!(phase, Phase::EnterHandle(e) if matches!(e.lookup, HandleLookup::Failed { error: e, .. } if e == error))
}

#[tokio::test(flavor = "multi_thread")]
async fn unknown_and_invalid_handles_are_reported() {
    let dir = fresh_dir("handles");
    let (chain, api) = (phone_chain(), FakeApi::down());
    let mut desktop = Desktop::start(&dir, &chain, &api);
    desktop.send(Command::SubmitHandle("Not Valid".into()));
    desktop
        .wait_for("invalid", |phase| failed(phase, LookupError::Invalid))
        .await;
    desktop.send(Command::SubmitHandle("bob".into()));
    desktop
        .wait_for("not found", |phase| failed(phase, LookupError::NotFound))
        .await;
    desktop.stop().await;
    std::fs::remove_dir_all(dir).unwrap();
}

// Chat: a linked desktop (@alice) and a scripted contact (@bob) on loopback. There is no relay,
// so the desktop reaches Bob only over a connection Bob opened, as it would a peer that dialed it.

const DESKTOP_SECRET: [u8; 32] = [0x66; 32];
const BOB_SECRET: [u8; 32] = [0x77; 32];
const BOB_QID: u64 = 7;

/// A data directory holding a linked @alice, and the address the desktop will listen on.
fn linked_dir(name: &str) -> (PathBuf, String) {
    let dir = fresh_dir(name);
    let store = Store::open(&dir).expect("store");
    let keys = KeyStore::File {
        path: dir.join("device.key"),
    };
    keys.save(&DESKTOP_SECRET).unwrap();
    store
        .save_identity(&crate::store::Identity {
            handle: "alice".into(),
            qid: U256::from(QID),
            chain_id: U256::from(CHAIN_ID),
            registry: REGISTRY,
            device_key: device_key_from_secret(DESKTOP_SECRET),
            linked: true,
        })
        .unwrap();
    let port = std::net::UdpSocket::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    (dir, format!("/ip4/127.0.0.1/udp/{port}/quic-v1"))
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_device_key_stops_startup_and_keeps_the_messages() {
    // As if QOP_KEY_STORE changed since linking: the identity is saved, its key is not here.
    let (dir, listen) = linked_dir("missing-key");
    Store::open(&dir).unwrap().upsert_contact("7", "bob").unwrap();
    std::fs::remove_file(dir.join("device.key")).unwrap();
    let keys = KeyStore::File {
        path: dir.join("device.key"),
    };
    let error = super::check_device_key(&Store::open(&dir).unwrap(), &keys).unwrap_err();
    assert!(error.contains("the device key file"), "{error}");

    let (chain, api) = (chat_chain(), FakeApi::down());
    let mut desktop = Desktop::start_on(&dir, &chain, &api, &listen);
    desktop.wait_for("starting", |p| matches!(p, Phase::Starting)).await;
    desktop.stop().await;
    let store = Store::open(&dir).unwrap();
    assert!(store.identity().unwrap().is_some());
    assert_eq!(store.contact("7").unwrap().as_deref(), Some("bob"));
}

#[tokio::test(flavor = "multi_thread")]
async fn unlink_finishes_when_the_key_cannot_be_deleted() {
    let (dir, listen) = linked_dir("unlink-key-stays");
    let (chain, api) = (chat_chain(), FakeApi::down());
    let mut desktop = Desktop::start_on(&dir, &chain, &api, &listen);
    desktop.wait_for("ready", ready).await;
    // A directory where the key file was: deleting it fails (unlink(2) refuses directories).
    let key = dir.join("device.key");
    std::fs::remove_file(&key).unwrap();
    std::fs::create_dir(&key).unwrap();
    desktop.send(Command::Unlink);
    desktop
        .wait_for("unlinked", |p| matches!(p, Phase::EnterHandle(_)))
        .await;
    desktop.stop().await;
    assert!(Store::open(&dir).unwrap().identity().unwrap().is_none());

    // A leftover key without an identity starts unlinked, and the next link adopts it.
    std::fs::remove_dir(&key).unwrap();
    let keys = KeyStore::File { path: key };
    keys.save(&DESKTOP_SECRET).unwrap();
    assert_eq!(
        super::check_device_key(&Store::open(&dir).unwrap(), &keys),
        Ok(())
    );
    let mut desktop = Desktop::start_on(&dir, &chain, &api, &listen);
    desktop
        .wait_for("unlinked", |p| matches!(p, Phase::EnterHandle(_)))
        .await;
    desktop.send(Command::SubmitHandle("alice".into()));
    let code = pairing_offer(&mut desktop).await;
    let offered = PairingOffer::decode(&code, super::now_seconds()).unwrap();
    assert_eq!(offered.device_key, device_key_from_secret(DESKTOP_SECRET));
    desktop.stop().await;
    std::fs::remove_dir_all(dir).unwrap();
}

/// Alice's own key is a member; Bob's device belongs to @bob.
fn chat_chain() -> FakeChain {
    let chain = FakeChain::default();
    chain.set_membership(Some(QID));
    chain.add_account(super::testing::account_with(
        BOB_QID,
        "bob",
        vec![device_key_from_secret(BOB_SECRET)],
    ));
    chain
}

fn linked(phase: &Phase) -> Option<&crate::model::Linked> {
    match phase {
        Phase::Linked(linked) => Some(linked),
        _ => None,
    }
}

/// The first message of the conversation with @bob passes `want`.
fn bob_message(phase: &Phase, want: impl Fn(&crate::model::Message) -> bool) -> bool {
    linked(phase)
        .and_then(|l| l.conversations.iter().find(|c| c.peer == "bob"))
        .and_then(|c| c.messages.first())
        .is_some_and(want)
}

fn ready(phase: &Phase) -> bool {
    linked(phase).is_some_and(|l| l.messaging == Messaging::Ready)
}

fn verifying(phase: &Phase) -> bool {
    linked(phase).is_some_and(|l| l.messaging == Messaging::Verifying)
}

struct Bob {
    node: Node,
    events: UnboundedReceiver<NodeEvent>,
    desktop: PeerId,
}

/// A node with `secret` speaking `protocol`, connected to the desktop listening on `listen`.
async fn dial_desktop(
    secret: [u8; 32],
    protocol: &str,
    listen: &str,
) -> (Node, UnboundedReceiver<NodeEvent>, PeerId) {
    let (node, events) = Node::start(NodeConfig {
        secret,
        agent_version: "peer".into(),
        protocols: vec![protocol.into()],
        inbound_stream_limits: vec![],
        relays: vec![],
        listen: vec!["/ip4/127.0.0.1/udp/0/quic-v1".into()],
        max_unread: MAX_SYNC_PAYLOAD_BYTES,
    })
    .expect("a peer node");
    let desktop = peer_id_from_device_key(&device_key_from_secret(DESKTOP_SECRET));
    let addr = format!("{listen}/p2p/{}", desktop.to_base58());
    node.handle()
        .connect(vec![addr])
        .await
        .expect("dials the desktop");
    (node, events, desktop)
}

fn seal_to_desktop(frame: &ChatFrame, sender: &[u8; 32]) -> Vec<u8> {
    crate::wire::chat_envelope::ChatCipher::new(sender)
        .seal(frame, &device_key_from_secret(DESKTOP_SECRET).0)
        .expect("an encrypted chat frame")
}

impl Bob {
    async fn connect(listen: &str) -> Bob {
        let (node, events, desktop) = dial_desktop(BOB_SECRET, CHAT_PROTOCOL, listen).await;
        Bob {
            node,
            events,
            desktop,
        }
    }

    /// Sends one message; the ACK, or `None` if the desktop reset the stream.
    async fn send(&self, id: &str, text: &str) -> Option<ChatAck> {
        let frame = ChatFrame {
            from_handle: "bob".into(),
            id: id.into(),
            sent_at: 1_700_000_000_000,
            text: text.into(),
        };
        let mut stream = self
            .node
            .handle()
            .open_stream(&self.desktop, CHAT_PROTOCOL)
            .await
            .expect("opens");
        stream
            .send_message(seal_to_desktop(&frame, &BOB_SECRET))
            .await
            .ok()?;
        let ack = stream.read_to_end(MAX_CHAT_PAYLOAD_BYTES).await.ok()?;
        Some(ChatAck::decode(&ack).expect("an ack"))
    }

    /// Reads the next inbound message; ACKs it, or resets the stream (refusing it).
    async fn receive(&mut self, ack: bool) -> ChatFrame {
        let mut stream = loop {
            match self.events.recv().await.expect("bob's node running") {
                NodeEvent::InboundStream(stream) => break stream,
                _ => continue,
            }
        };
        use crate::wire::chat_envelope::{ChatCipher, MAX_CHAT_ENVELOPE_BYTES};
        let bytes = stream.read_to_end(MAX_CHAT_ENVELOPE_BYTES).await.unwrap();
        let frame = ChatCipher::new(&BOB_SECRET)
            .open(&bytes, &device_key_from_secret(DESKTOP_SECRET).0)
            .expect("an encrypted chat frame from desktop");
        if ack {
            let reply = ChatAck {
                ack: frame.id.clone(),
            }
            .encode()
            .unwrap();
            stream.send_message(reply).await.unwrap();
        } else {
            stream.reset();
        }
        frame
    }
}

const BOB_MESSAGE: &str = "0b0b0b0b-0000-4000-8000-000000000001";

#[tokio::test(flavor = "multi_thread")]
async fn chat_streams_past_eight_wait_then_are_saved_and_acked() {
    let (dir, listen) = linked_dir("inbound-chat-queue");
    let (chain, api) = (chat_chain(), FakeApi::down());
    let mut desktop = Desktop::start_on(&dir, &chain, &api, &listen);
    desktop.wait_for("ready", ready).await;
    let bob = Bob::connect(&listen).await;

    tokio::time::timeout(Duration::from_secs(15), async {
        let mut held = Vec::new();
        for _ in 0..chat::MAX_INBOUND_STREAMS {
            held.push(
                bob.node
                    .handle()
                    .open_stream(&bob.desktop, CHAT_PROTOCOL)
                    .await
                    .unwrap(),
            );
        }
        let mut queued = bob
            .node
            .handle()
            .open_stream(&bob.desktop, CHAT_PROTOCOL)
            .await
            .unwrap();
        let frame = ChatFrame {
            from_handle: "bob".into(),
            id: BOB_MESSAGE.into(),
            sent_at: 1_700_000_000_000,
            text: "queued behind eight open streams".into(),
        };
        queued
            .send_message(seal_to_desktop(&frame, &BOB_SECRET))
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(
                Duration::from_millis(100),
                queued.read_to_end(MAX_CHAT_PAYLOAD_BYTES),
            )
            .await
            .is_err(),
            "the ninth stream must wait, not be handled or reset"
        );

        for (i, mut stream) in held.into_iter().enumerate() {
            let frame = ChatFrame {
                id: format!("0b0b0b0b-0000-4000-8000-{:012x}", i + 2),
                text: format!("held message {i}"),
                ..frame.clone()
            };
            stream
                .send_message(seal_to_desktop(&frame, &BOB_SECRET))
                .await
                .unwrap();
            let ack = stream.read_to_end(MAX_CHAT_PAYLOAD_BYTES).await.unwrap();
            assert_eq!(ChatAck::decode(&ack).unwrap().ack, frame.id);
        }
        let ack = queued.read_to_end(MAX_CHAT_PAYLOAD_BYTES).await.unwrap();
        assert_eq!(ChatAck::decode(&ack).unwrap().ack, BOB_MESSAGE);
    })
    .await
    .expect("all nine messages delivered without a retry");

    desktop.stop().await;
    let store = Store::open(&dir).unwrap();
    assert_eq!(
        store.inbox_all().unwrap().len(),
        chat::MAX_INBOUND_STREAMS + 1
    );
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn reset_during_verification_keeps_the_chat_handler_slot() {
    let (dir, listen) = linked_dir("reset-chat-handler");
    let (chain, api) = (chat_chain(), FakeApi::down());
    let other_secret = [0x78; 32];
    chain.add_account(super::testing::account_with(
        BOB_QID,
        "bob",
        vec![device_key_from_secret(other_secret)],
    ));
    let mut desktop = Desktop::start_on(&dir, &chain, &api, &listen);
    desktop.wait_for("ready", ready).await;
    let bob = Bob::connect(&listen).await;
    let hold = chain.hold_lookups();
    let frame = ChatFrame {
        from_handle: "bob".into(),
        id: BOB_MESSAGE.into(),
        sent_at: 1_700_000_000_000,
        text: "verification outlives the reset".into(),
    };
    let mut first = bob
        .node
        .handle()
        .open_stream(&bob.desktop, CHAT_PROTOCOL)
        .await
        .unwrap();
    first
        .send_message(seal_to_desktop(&frame, &BOB_SECRET))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), hold.entered())
        .await
        .unwrap();
    let mut held = Vec::new();
    for _ in 1..chat::MAX_INBOUND_STREAMS {
        held.push(
            bob.node
                .handle()
                .open_stream(&bob.desktop, CHAT_PROTOCOL)
                .await
                .unwrap(),
        );
    }
    first.reset();

    let (other, _events, peer) = dial_desktop(other_secret, CHAT_PROTOCOL, &listen).await;
    let mut ninth = other
        .handle()
        .open_stream(&peer, CHAT_PROTOCOL)
        .await
        .unwrap();
    let frame = ChatFrame {
        id: "0b0b0b0b-0000-4000-8000-000000000009".into(),
        ..frame
    };
    ninth
        .send_message(seal_to_desktop(&frame, &other_secret))
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(
            Duration::from_millis(200),
            ninth.read_to_end(MAX_CHAT_PAYLOAD_BYTES)
        )
        .await
        .is_err(),
        "the ninth handler must wait for verification of the reset stream to finish"
    );
    hold.release();
    let ack = tokio::time::timeout(
        Duration::from_secs(5),
        ninth.read_to_end(MAX_CHAT_PAYLOAD_BYTES),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(ChatAck::decode(&ack).unwrap().ack, frame.id);
    for mut stream in held {
        stream.reset();
    }
    desktop.stop().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_saved_message_shows_even_when_its_ack_cannot_be_written() {
    let (dir, listen) = linked_dir("lost-ack");
    let (chain, api) = (chat_chain(), FakeApi::down());
    let mut desktop = Desktop::start_on(&dir, &chain, &api, &listen);
    desktop.wait_for("ready", ready).await;

    // Bob sends, then abandons the stream while the desktop is still verifying him.
    let bob = Bob::connect(&listen).await;
    let hold = chain.hold_lookups();
    let frame = ChatFrame {
        from_handle: "bob".into(),
        id: BOB_MESSAGE.into(),
        sent_at: 1_700_000_000_000,
        text: "hi alice".into(),
    };
    let mut stream = bob
        .node
        .handle()
        .open_stream(&bob.desktop, CHAT_PROTOCOL)
        .await
        .expect("opens");
    stream
        .send_message(seal_to_desktop(&frame, &BOB_SECRET))
        .await
        .unwrap();
    hold.entered().await;
    stream.reset();
    tokio::time::sleep(Duration::from_millis(300)).await;
    hold.release();

    desktop
        .wait_for("bob's message", |p| {
            bob_message(p, |m| m.text == "hi alice")
        })
        .await;
    desktop.stop().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn receives_saves_then_acks_and_marks_read() {
    let (dir, listen) = linked_dir("receive");
    let (chain, api) = (chat_chain(), FakeApi::down());
    let mut desktop = Desktop::start_on(&dir, &chain, &api, &listen);
    desktop.wait_for("ready", ready).await;

    let bob = Bob::connect(&listen).await;
    let ack = bob.send(BOB_MESSAGE, "hi alice").await;
    assert_eq!(ack.map(|a| a.ack).as_deref(), Some(BOB_MESSAGE));
    let phase = desktop
        .wait_for("bob's message", |p| {
            bob_message(p, |m| {
                m.text == "hi alice" && m.direction == Direction::Received
            })
        })
        .await;
    let conversation = linked(&phase).unwrap().conversations[0].clone();
    assert_eq!(
        (conversation.peer.as_str(), conversation.unread),
        ("bob", 1)
    );
    assert_eq!(conversation.id.0, BOB_QID.to_string());

    // A resend of the same message is acknowledged again but stored once.
    assert!(bob.send(BOB_MESSAGE, "hi alice").await.is_some());
    desktop.send(Command::OpenConversation(conversation.id.clone()));
    desktop
        .wait_for("read", |p| {
            linked(p).is_some_and(|l| {
                l.conversations[0].unread == 0 && l.conversations[0].messages.len() == 1
            })
        })
        .await;
    // The same id with other text conflicts: refused, not acknowledged.
    assert!(bob.send(BOB_MESSAGE, "edited").await.is_none());
    // Off screen (Settings or New chat), what arrives stays unread. Commands run in order, so
    // once the invalid New chat lookup shows, the close has been handled too.
    desktop.send(Command::CloseConversation);
    desktop.send(Command::StartChat("!".into()));
    desktop
        .wait_for("closed", |p| {
            linked(p).is_some_and(|l| {
                matches!(
                    &l.new_chat,
                    NewChat::Lookup(HandleLookup::Failed {
                        error: LookupError::Invalid,
                        ..
                    })
                )
            })
        })
        .await;
    let away = "0b0b0b0b-0000-4000-8000-000000000002";
    assert!(bob.send(away, "while you were away").await.is_some());
    desktop
        .wait_for("unread while away", |p| {
            linked(p).is_some_and(|l| {
                l.conversations[0].unread == 1 && l.conversations[0].messages.len() == 2
            })
        })
        .await;
    drop(bob);
    desktop.stop().await;

    // Saved before the ACK: still there after a restart.
    let mut desktop = Desktop::start_on(&dir, &chain, &api, &listen);
    desktop
        .wait_for("bob's message after restart", |p| {
            bob_message(p, |m| m.text == "hi alice")
        })
        .await;
    desktop.stop().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn sends_and_marks_delivered_only_on_the_ack() {
    let (dir, listen) = linked_dir("send");
    let (chain, api) = (chat_chain(), FakeApi::down());
    let mut desktop = Desktop::start_on(&dir, &chain, &api, &listen);
    desktop.wait_for("ready", ready).await;

    desktop.send(Command::StartChat("nobody".into()));
    desktop
        .wait_for("not found", |p| {
            linked(p).is_some_and(|l| {
                matches!(
                    &l.new_chat,
                    NewChat::Lookup(HandleLookup::Failed {
                        error: LookupError::NotFound,
                        ..
                    })
                )
            })
        })
        .await;
    desktop.send(Command::StartChat("bob".into()));
    let phase = desktop
        .wait_for("resolved", |p| {
            linked(p).is_some_and(|l| matches!(l.new_chat, NewChat::Resolved { .. }))
        })
        .await;
    let Some(NewChat::Resolved { conversation, .. }) = linked(&phase).map(|l| l.new_chat.clone())
    else {
        unreachable!()
    };
    assert!(
        linked(&phase)
            .unwrap()
            .conversation(&conversation)
            .is_some()
    );

    let mut bob = Bob::connect(&listen).await;
    desktop.send(Command::Send {
        conversation: conversation.clone(),
        text: "hello bob".into(),
    });
    let frame = bob.receive(true).await;
    assert_eq!(
        (frame.from_handle.as_str(), frame.text.as_str()),
        ("alice", "hello bob")
    );
    desktop
        .wait_for("delivered", |p| {
            bob_message(p, |m| m.direction == Direction::Sent(MessageStatus::Sent))
        })
        .await;
    desktop.stop().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn queues_while_offline_and_delivers_after_a_restart() {
    let (dir, listen) = linked_dir("queue");
    let (chain, api) = (chat_chain(), FakeApi::down());
    let mut desktop = Desktop::start_on(&dir, &chain, &api, &listen);
    desktop.wait_for("ready", ready).await;
    desktop.send(Command::StartChat("bob".into()));
    desktop
        .wait_for("resolved", |p| {
            linked(p).is_some_and(|l| matches!(l.new_chat, NewChat::Resolved { .. }))
        })
        .await;
    desktop.send(Command::Send {
        conversation: crate::model::ConversationId(BOB_QID.to_string()),
        text: "are you there?".into(),
    });
    // Bob is offline: the attempt fails and the message stays queued.
    desktop
        .wait_for("queued", |p| {
            bob_message(p, |m| m.direction == Direction::Sent(MessageStatus::Queued))
        })
        .await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    desktop.stop().await;
    {
        let store = Store::open(&dir).unwrap();
        let queued = store.queued().unwrap();
        assert_eq!(queued.len(), 1);
        assert!(queued[0].attempts >= 1, "{queued:?}");
    }

    // After a restart, Bob comes online: his connection wakes the outbox despite the backoff.
    let mut desktop = Desktop::start_on(&dir, &chain, &api, &listen);
    desktop.wait_for("ready", ready).await;
    let mut bob = Bob::connect(&listen).await;
    assert_eq!(bob.receive(true).await.text, "are you there?");
    desktop
        .wait_for("delivered", |p| {
            bob_message(p, |m| m.direction == Direction::Sent(MessageStatus::Sent))
        })
        .await;
    desktop.stop().await;
    std::fs::remove_dir_all(dir).unwrap();
}

/// Revocation safety: a peer refusing us, an RPC failure, and a stuck head each pause messaging
/// and re-read our membership, but never touch the key or the messages.
#[tokio::test(flavor = "multi_thread")]
async fn pauses_on_rejection_rpc_failure_and_a_stuck_head_but_keeps_everything() {
    let (dir, listen) = linked_dir("pause");
    let (chain, api) = (chat_chain(), FakeApi::down());
    let mut desktop = Desktop::start_on(&dir, &chain, &api, &listen);
    desktop.wait_for("ready", ready).await;
    let mut bob = Bob::connect(&listen).await;
    assert!(bob.send(BOB_MESSAGE, "hi").await.is_some());
    desktop
        .wait_for("bob's message", |p| bob_message(p, |_| true))
        .await;

    // Bob refuses our message (as a peer that cannot verify us would): stay queued, pause, and
    // resume once a newer head confirms our membership again.
    desktop.send(Command::Send {
        conversation: crate::model::ConversationId(BOB_QID.to_string()),
        text: "refused".into(),
    });
    assert_eq!(bob.receive(false).await.text, "refused");
    desktop.wait_for("paused after rejection", verifying).await;
    desktop.wait_for("ready again", ready).await;

    // A stuck head: Bob refuses again; our re-read lands on the head of our last confirmation,
    // which is no new confirmation, so messaging stays paused until the head moves.
    chain.stick_head(true);
    desktop.send(Command::Send {
        conversation: crate::model::ConversationId(BOB_QID.to_string()),
        text: "stuck".into(),
    });
    bob.receive(false).await;
    desktop.wait_for("paused on a stuck head", verifying).await;
    desktop.stays_paused().await;
    assert!(dir.join("device.key").exists());
    chain.stick_head(false);
    desktop.wait_for("ready after the head moves", ready).await;

    // The RPC fails outright: Bob reconnects (a new connection has nothing cached), his
    // message cannot be verified, and messaging pauses. Nothing is wiped.
    let old = *bob.node.peer_id();
    drop(bob);
    desktop.wait_disconnected(&old).await;
    let bob = Bob::connect(&listen).await;
    chain.fail_lookups(true);
    assert!(
        bob.send("0b0b0b0b-0000-4000-8000-000000000002", "during outage")
            .await
            .is_none()
    );
    desktop.wait_for("paused on rpc failure", verifying).await;
    // Our own read fails too: the UI says the chain is unreachable, calmly.
    desktop
        .wait_for("the chain unreachable", |p| {
            linked(p).is_some_and(|l| l.trouble == Some(crate::model::Unreachable::Chain))
        })
        .await;
    desktop.stays_paused().await;
    assert!(dir.join("device.key").exists());
    chain.fail_lookups(false);
    let phase = desktop.wait_for("ready after the outage", ready).await;
    assert_eq!(linked(&phase).unwrap().trouble, None);
    let conversation = &linked(&phase).unwrap().conversations[0];
    assert!(conversation.messages.iter().any(|m| m.text == "hi"));
    assert!(conversation.messages.iter().any(|m| m.text == "refused"));
    desktop.stop().await;
    std::fs::remove_dir_all(dir).unwrap();
}

// Sync: Alice's phone (an active device of @alice) speaks `/qop/sync/1` to the linked desktop.

/// A device that speaks `/qop/sync/1` to the desktop: Alice's phone, or anyone else.
struct SyncPeer {
    node: Node,
    desktop: PeerId,
    device_key: alloy_primitives::B256,
}

impl SyncPeer {
    async fn connect(secret: [u8; 32], listen: &str) -> SyncPeer {
        let (node, _events, desktop) = dial_desktop(secret, SYNC_PROTOCOL, listen).await;
        SyncPeer {
            node,
            desktop,
            device_key: device_key_from_secret(secret),
        }
    }

    /// One request, one response; `None` when the desktop reset the stream.
    async fn request(&self, request: &SyncRequest) -> Option<SyncResponse> {
        let mut stream = self
            .node
            .handle()
            .open_stream(&self.desktop, SYNC_PROTOCOL)
            .await
            .ok()?;
        stream.send_message(request.encode().unwrap()).await.ok()?;
        let reply = stream.read_to_end(MAX_SYNC_PAYLOAD_BYTES).await.ok()?;
        Some(SyncResponse::decode(&reply).expect("a sync response"))
    }

    async fn hand_off(&self, record: &OutboxRecord) -> Option<SyncResponse> {
        let request = SyncRequest::Handoff {
            composed_by: self.device_key,
            record: record.clone(),
        };
        self.request(&request).await
    }

    async fn receipts(&self, id: &str) -> Vec<SyncReceipt> {
        let request = SyncRequest::Poll {
            ids: vec![id.into()],
        };
        match self.request(&request).await {
            Some(SyncResponse::Receipts { receipts }) => receipts,
            other => panic!("not receipts: {other:?}"),
        }
    }

    async fn catch_up(&self, after: u64) -> (u64, Vec<u64>) {
        match self.request(&SyncRequest::Catchup { after }).await {
            Some(SyncResponse::Inbox { last_seq, records }) => {
                (last_seq, records.iter().map(|item| item.seq).collect())
            }
            other => panic!("not an inbox page: {other:?}"),
        }
    }
}

const HANDOFF_ID: &str = "a1a1a1a1-0000-4000-8000-000000000001";

/// The phone's queued message for @bob, as `outgoingHandoffRecord` builds it.
fn handoff_record(id: &str, text: &str) -> OutboxRecord {
    let frame = ChatFrame {
        from_handle: "alice".into(),
        id: id.into(),
        sent_at: 1_700_000_000_000,
        text: text.into(),
    };
    super::outbox::new_record(frame, "bob", &BOB_QID.to_string(), 1_700_000_000_000)
}

/// Alice's account has the phone as an active device, next to the desktop.
fn sync_chain() -> FakeChain {
    let chain = chat_chain();
    chain.set_devices(vec![device_key_from_secret(PHONE_SECRET)]);
    chain
}

/// An outbox record's status, read beside the running desktop (which holds the store's lock).
fn stored_status(dir: &Path, id: &str) -> Option<String> {
    use rusqlite::OptionalExtension;
    rusqlite::Connection::open(dir.join("qop.db"))
        .unwrap()
        .query_row("SELECT status FROM outbox WHERE id = ?1", [id], |row| row.get(0))
        .optional()
        .unwrap()
}

fn held(id: &str) -> Option<SyncResponse> {
    Some(SyncResponse::Held { id: id.into() })
}

fn sync_error(reason: SyncErrorReason) -> Option<SyncResponse> {
    Some(SyncResponse::Error { reason })
}

#[tokio::test(flavor = "multi_thread")]
async fn holds_a_handoff_delivers_it_and_reports_the_receipt() {
    let (dir, listen) = linked_dir("handoff");
    let (chain, api) = (sync_chain(), FakeApi::down());
    let mut desktop = Desktop::start_on(&dir, &chain, &api, &listen);
    desktop.wait_for("ready", ready).await;

    // Bob is offline: the handoff is held (saved first), and stays queued.
    let phone = SyncPeer::connect(PHONE_SECRET, &listen).await;
    let record = handoff_record(HANDOFF_ID, "from my phone");
    assert_eq!(phone.hand_off(&record).await, held(HANDOFF_ID));
    assert_eq!(stored_status(&dir, HANDOFF_ID).as_deref(), Some("queued"));
    desktop
        .wait_for("the handoff in bob's chat", |p| {
            bob_message(p, |m| {
                m.text == "from my phone" && m.direction == Direction::Sent(MessageStatus::Queued)
            })
        })
        .await;
    assert_eq!(phone.receipts(HANDOFF_ID).await, vec![]);

    // Handing it off again is idempotent; other content under the same id conflicts; only our
    // own queued message to someone else, composed by the peer itself, is accepted.
    assert_eq!(phone.hand_off(&record).await, held(HANDOFF_ID));
    let edited = handoff_record(HANDOFF_ID, "edited");
    assert_eq!(phone.hand_off(&edited).await, sync_error(SyncErrorReason::Conflict));
    let other_id = "a1a1a1a1-0000-4000-8000-000000000002";
    let mut forged = handoff_record(other_id, "forged");
    forged.frame.from_handle = "bob".into();
    assert_eq!(phone.hand_off(&forged).await, sync_error(SyncErrorReason::Invalid));
    let mut to_self = handoff_record(other_id, "to myself");
    to_self.to_qid = QID.to_string();
    assert_eq!(phone.hand_off(&to_self).await, sync_error(SyncErrorReason::Invalid));
    let not_composed = SyncRequest::Handoff {
        composed_by: alloy_primitives::B256::repeat_byte(1),
        record: handoff_record(other_id, "someone else's"),
    };
    assert_eq!(phone.request(&not_composed).await, sync_error(SyncErrorReason::Invalid));
    // Within the character limit, but about 24 KiB encoded: no chat frame could carry it.
    let unsendable = handoff_record(other_id, &"\u{1}".repeat(4000));
    assert_eq!(phone.hand_off(&unsendable).await, sync_error(SyncErrorReason::Invalid));
    assert_eq!(stored_status(&dir, other_id), None);

    // Bob comes online: delivered on his ACK, and the phone's poll gets the receipt.
    let mut bob = Bob::connect(&listen).await;
    let frame = bob.receive(true).await;
    assert_eq!((frame.id.as_str(), frame.text.as_str()), (HANDOFF_ID, "from my phone"));
    desktop
        .wait_for("delivered", |p| {
            bob_message(p, |m| m.direction == Direction::Sent(MessageStatus::Sent))
        })
        .await;
    let receipts = phone.receipts(HANDOFF_ID).await;
    assert_eq!(receipts.len(), 1);
    assert_eq!(
        (receipts[0].id.as_str(), receipts[0].to_qid.as_str()),
        (HANDOFF_ID, "7")
    );
    desktop.stop().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_catch_up_pages_from_the_inbox_cursor() {
    let (dir, listen) = linked_dir("catchup");
    {
        let store = Store::open(&dir).unwrap();
        for n in 1..=70_u64 {
            let record = crate::wire::InboxRecord {
                frame: ChatFrame {
                    from_handle: "bob".into(),
                    id: format!("0c0c0c0c-0000-4000-8000-{n:012}"),
                    sent_at: 1_700_000_000_000 + n,
                    text: format!("message {n}"),
                },
                from_qid: BOB_QID.to_string(),
                received_at: 1_700_000_000_000 + n,
            };
            assert!(store.put_inbox(&record).unwrap());
        }
    }
    let (chain, api) = (sync_chain(), FakeApi::down());
    let mut desktop = Desktop::start_on(&dir, &chain, &api, &listen);
    desktop.wait_for("ready", ready).await;

    let phone = SyncPeer::connect(PHONE_SECRET, &listen).await;
    let (last, first) = phone.catch_up(0).await;
    assert_eq!((last, first.len()), (70, super::sync::CATCHUP_ROW_LIMIT));
    assert_eq!(first, (1..=64).collect::<Vec<_>>());
    let (_, second) = phone.catch_up(64).await;
    assert_eq!(second, (65..=70).collect::<Vec<_>>());
    assert_eq!(phone.catch_up(70).await, (70, vec![]));
    // A cursor past the end (the phone's holder was wiped) gets the true last seq back.
    assert_eq!(phone.catch_up(500).await, (70, vec![]));

    // Bob writes; the next page carries exactly that.
    let bob = Bob::connect(&listen).await;
    assert!(bob.send(BOB_MESSAGE, "while the phone was away").await.is_some());
    assert_eq!(phone.catch_up(70).await, (71, vec![71]));
    desktop.stop().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_sync_from_other_accounts_and_while_paused() {
    let (dir, listen) = linked_dir("sync-refuse");
    let (chain, api) = (sync_chain(), FakeApi::down());
    // Our own membership cannot be confirmed yet: messaging stays paused.
    chain.set_membership(None);
    let mut desktop = Desktop::start_on(&dir, &chain, &api, &listen);
    desktop.wait_for("verifying", verifying).await;
    let phone = SyncPeer::connect(PHONE_SECRET, &listen).await;
    let record = handoff_record(HANDOFF_ID, "while paused");
    assert_eq!(phone.hand_off(&record).await, None);
    assert_eq!(phone.request(&SyncRequest::Catchup { after: 0 }).await, None);

    chain.set_membership(Some(QID));
    desktop.wait_for("ready", ready).await;
    // Bob is an active device, but of @bob; a stranger is no device at all. Both are reset
    // before anything is stored.
    let bob = SyncPeer::connect(BOB_SECRET, &listen).await;
    let mut bobs = handoff_record(HANDOFF_ID, "bob pretending");
    bobs.to_qid = "9".into();
    assert_eq!(bob.hand_off(&bobs).await, None);
    assert_eq!(bob.request(&SyncRequest::Catchup { after: 0 }).await, None);
    chain.add_stranger(device_key_from_secret([0x99; 32]));
    let stranger = SyncPeer::connect([0x99; 32], &listen).await;
    assert_eq!(stranger.hand_off(&record).await, None);
    assert_eq!(stored_status(&dir, HANDOFF_ID), None);
    // The phone itself is served once messaging is ready.
    assert_eq!(phone.hand_off(&record).await, held(HANDOFF_ID));
    desktop.stop().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn delivers_offline_via_mailbox_and_drains_on_reconnect() {
    use crate::wire::mailbox::{
        MAILBOX_PROTOCOL, MAX_MAILBOX_PAYLOAD_BYTES, MailboxMessage, MailboxResponse,
    };
    use std::sync::Mutex;

    struct StoredEnvelope {
        recipient: String,
        sender: String,
        id: String,
        envelope: String,
        seq: u64,
    }

    // Minimal QUIC /qop/mailbox/1 node storing opaque envelopes keyed by recipient device key.
    let stored: Arc<Mutex<Vec<StoredEnvelope>>> = Arc::new(Mutex::new(Vec::new()));
    let stored_server = stored.clone();
    let (mailbox_node, mut mailbox_events) = Node::start(NodeConfig {
        secret: [0x44u8; 32],
        agent_version: "qop-mailbox-test".into(),
        protocols: vec![MAILBOX_PROTOCOL.into()],
        inbound_stream_limits: vec![],
        relays: vec![],
        listen: vec!["/ip4/127.0.0.1/udp/0/quic-v1".into()],
        max_unread: MAX_MAILBOX_PAYLOAD_BYTES,
    })
    .expect("mailbox node");
    let mailbox_addr = mailbox_node.listen_addrs()[0].clone();

    let server_task = tokio::spawn(async move {
        let _keep_node = mailbox_node;
        let mut next_seq = 1u64;
        while let Some(event) = mailbox_events.recv().await {
            if let NodeEvent::InboundStream(mut stream) = event {
                let stored = stored_server.clone();
                let seq_base = next_seq;
                next_seq += 100;
                tokio::spawn(async move {
                    let Ok(bytes) = stream.read_to_end(MAX_MAILBOX_PAYLOAD_BYTES).await else {
                        return;
                    };
                    let Ok(req) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
                        return;
                    };
                    let caller_key =
                        crate::wire::identity::device_key_from_peer_id(&stream.peer.to_string())
                            .map(|k| format!("{k:#x}"))
                            .unwrap_or_default();
                    let response = match req.get("type").and_then(|v| v.as_str()) {
                        Some("deposit") => {
                            let mut deposited_items = Vec::new();
                            if let Some(items) = req.get("items").and_then(|v| v.as_array()) {
                                let mut guard = stored.lock().unwrap();
                                for (i, item) in items.iter().enumerate() {
                                    let id = item["id"].as_str().unwrap_or_default().to_string();
                                    let rcpt = item["recipientDeviceKey"]
                                        .as_str()
                                        .unwrap_or_default()
                                        .to_lowercase();
                                    let env = item["envelope"]
                                        .as_str()
                                        .unwrap_or_default()
                                        .to_string();
                                    guard.push(StoredEnvelope {
                                        recipient: rcpt.clone(),
                                        sender: caller_key.clone(),
                                        id: id.clone(),
                                        envelope: env,
                                        seq: seq_base + i as u64,
                                    });
                                    deposited_items.push(serde_json::json!({
                                        "id": id,
                                        "recipientDeviceKey": rcpt,
                                    }));
                                }
                            }
                            serde_json::json!({ "v": 1, "type": "deposited", "items": deposited_items })
                        }
                        Some("fetch") => {
                            let guard = stored.lock().unwrap();
                            let items: Vec<serde_json::Value> = guard
                                .iter()
                                .filter(|e| e.recipient == caller_key)
                                .map(|e| {
                                    serde_json::json!({
                                        "seq": e.seq,
                                        "id": e.id,
                                        "senderDeviceKey": e.sender,
                                        "storedAt": 1_700_000_000_000u64,
                                        "envelope": e.envelope,
                                    })
                                })
                                .collect();
                            let payload = serde_json::json!({
                                "v": 1,
                                "type": "messages",
                                "items": items,
                                "hasMore": false,
                            });
                            // Verify server payload satisfies the strict Rust wire decoder.
                            let encoded = serde_json::to_vec(&payload).unwrap();
                            assert!(matches!(
                                MailboxResponse::decode(&encoded),
                                Ok(MailboxResponse::Messages { .. })
                            ));
                            let _ = std::mem::size_of::<MailboxMessage>();
                            payload
                        }
                        Some("ack") => {
                            let seqs: Vec<u64> = req["seqs"]
                                .as_array()
                                .map(|arr| arr.iter().filter_map(|v| v.as_u64()).collect())
                                .unwrap_or_default();
                            let mut guard = stored.lock().unwrap();
                            let before = guard.len();
                            guard.retain(|e| !(e.recipient == caller_key && seqs.contains(&e.seq)));
                            let count = before - guard.len();
                            serde_json::json!({ "v": 1, "type": "acked", "count": count })
                        }
                        _ => serde_json::json!({ "v": 1, "type": "error", "reason": "invalid" }),
                    };
                    let _ = stream
                        .send_message(serde_json::to_vec(&response).unwrap())
                        .await;
                });
            }
        }
    });

    // 1. Alice (Rust Desktop) sends to offline Bob with the mailbox configured.
    let (alice_dir, alice_listen) = linked_dir("mailbox-alice");
    let (chain, api) = (chat_chain(), FakeApi::down());
    let mut alice = Desktop::start_with_mailboxes(
        &alice_dir,
        &chain,
        &api,
        &alice_listen,
        vec![mailbox_addr.clone()],
    );
    alice.wait_for("alice ready", ready).await;
    alice.send(Command::StartChat("bob".into()));
    let phase = alice
        .wait_for("bob resolved", |p| {
            linked(p).is_some_and(|l| matches!(l.new_chat, NewChat::Resolved { .. }))
        })
        .await;
    let NewChat::Resolved { conversation, .. } = &linked(&phase).unwrap().new_chat else {
        unreachable!();
    };
    alice.send(Command::Send {
        conversation: conversation.clone(),
        text: "offline from rust desktop".into(),
    });
    alice
        .wait_for("alice marked sent via mailbox", |p| {
            bob_message(p, |m| {
                m.text == "offline from rust desktop"
                    && m.direction == Direction::Sent(MessageStatus::Sent)
            })
        })
        .await;
    alice.stop().await;
    assert_eq!(stored.lock().unwrap().len(), 1);

    // 2. Bob (Rust Desktop) comes online later and drains the mailbox automatically.
    let bob_dir = fresh_dir("mailbox-bob");
    let bob_store = Store::open(&bob_dir).unwrap();
    let bob_key = device_key_from_secret(BOB_SECRET);
    let bob_keys = KeyStore::File {
        path: bob_dir.join("device.key"),
    };
    bob_keys.save(&BOB_SECRET).unwrap();
    bob_store
        .save_identity(&crate::store::Identity {
            qid: U256::from(BOB_QID),
            handle: "bob".into(),
            device_key: bob_key,
            chain_id: U256::from(CHAIN_ID),
            registry: REGISTRY,
            linked: true,
        })
        .unwrap();
    drop(bob_store);

    let bob_chain = chat_chain();
    bob_chain.set_membership(Some(BOB_QID));
    bob_chain.add_account(super::testing::account_with(
        QID,
        "alice",
        vec![device_key_from_secret(DESKTOP_SECRET)],
    ));
    let mut bob = Desktop::start_with_mailboxes(
        &bob_dir,
        &bob_chain,
        &api,
        "/ip4/127.0.0.1/udp/0/quic-v1",
        vec![mailbox_addr],
    );
    bob.wait_for("bob received from mailbox", |p| {
        linked(p).is_some_and(|l| {
            l.conversations.iter().any(|c| {
                c.messages.iter().any(|m| {
                    m.text == "offline from rust desktop" && m.direction == Direction::Received
                })
            })
        })
    })
    .await;
    // Inbox updates publish immediately after local insert, before ACK finishes;
    // wait briefly for the background ACK to clear the mailbox.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while !stored.lock().unwrap().is_empty() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "mailbox entry was not ACKed"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    bob.stop().await;
    server_task.abort();
    std::fs::remove_dir_all(alice_dir).unwrap();
    std::fs::remove_dir_all(bob_dir).unwrap();
}
