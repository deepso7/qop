//! The engine end to end in-process: a real node on loopback, a scripted phone node speaking
//! `/qop/pair/1`, fake chain and API, and restarts over the same data directory.

use std::path::{Path, PathBuf};
use std::time::Duration;

use alloy_primitives::U256;
use minip2p::PeerId;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio::task::JoinHandle;

use super::testing::{CHAIN_ID, FakeApi, FakeChain, QID, REGISTRY, approval_for};
use super::{Engine, Publish};
use crate::config::Config;
use crate::keys::KeyStore;
use crate::model::{Command, EnrollmentProgress, HandleLookup, LookupError, Model, Offer, Phase};
use crate::node::{Node, NodeConfig, NodeHandle};
use crate::store::Store;
use crate::wire::{
    DeviceActionApproval, DeviceActionStatus, PAIR_PROTOCOL, PAIRING_FRAME_MAX_BYTES, PairingFrame,
    PairingOffer, device_key_from_secret, peer_id_from_device_key,
};

const PHONE_SECRET: [u8; 32] = [0x55; 32];
const DEADLINE: u64 = 1_700_003_600;

struct Desktop {
    models: UnboundedReceiver<Model>,
    commands: UnboundedSender<Command>,
    task: JoinHandle<()>,
}

impl Desktop {
    fn start(dir: &Path, chain: &FakeChain, api: &FakeApi) -> Desktop {
        let config = Config {
            rpc_url: "http://unused".into(),
            registry: REGISTRY,
            chain_id: U256::from(CHAIN_ID),
            api_url: None,
            relays: vec![],
            listen: vec!["/ip4/127.0.0.1/udp/0/quic-v1".into()],
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
            relays: vec![],
            listen: vec!["/ip4/127.0.0.1/udp/0/quic-v1".into()],
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
    desktop.send(Command::AcknowledgeRevoked);
    desktop
        .wait_for("a fresh start", |phase| {
            matches!(phase, Phase::EnterHandle(_))
        })
        .await;
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
