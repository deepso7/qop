//! Fake models for headless scenes and tests, until the engine publishes real ones.

use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use super::{Pane, Ui};
use crate::model::*;

const HANDLE: &str = "alice";

/// A pairing payload the size of a real one (about 600 characters of base64url).
fn code(seed: u32) -> String {
    const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut x = seed.wrapping_mul(2_654_435_761) | 1;
    let body: String = (0..600)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            B64[(x % 64) as usize] as char
        })
        .collect();
    format!("qop-pair1.{body}")
}

fn offer(left: Duration) -> Offer {
    Offer { code: code(7), fingerprint: "9F3A21C4".into(), expires_at: SystemTime::now() + left }
}

fn ago(secs: u64) -> SystemTime {
    SystemTime::now() - Duration::from_secs(secs)
}

fn msg(id: &str, direction: Direction, text: &str, secs_ago: u64) -> Message {
    Message { id: MessageId(id.into()), direction, text: text.into(), at: ago(secs_ago) }
}

fn linked(conversations: Vec<Conversation>) -> Linked {
    Linked {
        account: Account {
            handle: HANDLE.into(),
            peer_id: "12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo".into(),
            fingerprint: "9F3A21C4".into(),
            data_dir: PathBuf::from("~/Library/Application Support/qop"),
        },
        conversations,
        messaging: Messaging::Ready,
        relay: RelayStatus::Connected,
        trouble: None,
        new_chat: NewChat::Lookup(HandleLookup::Idle),
    }
}

fn conversations() -> Vec<Conversation> {
    const IN: Direction = Direction::Received;
    const DELIVERED: Direction = Direction::Sent(MessageStatus::Sent);
    const QUEUED: Direction = Direction::Sent(MessageStatus::Queued);
    const FAILED: Direction = Direction::Sent(MessageStatus::Failed);
    vec![
        Conversation {
            id: ConversationId("bob".into()),
            peer: "bob".into(),
            unread: 0,
            messages: vec![
                msg("b1", IN, "hey! is this the desktop app you were talking about?", 3_600),
                msg("b2", DELIVERED, "yes, just linked it to my phone. scanned a QR and that was it", 3_500),
                msg("b3", DELIVERED, "no account key on the laptop either, the phone stays in charge", 3_480),
                msg("b4", IN, "nice. does it work when my phone is off?", 900),
                msg("b5", IN, "like, if I'm on the train", 880),
                msg("b6", DELIVERED, "yep, it's its own device. messages queue until you're back online", 600),
                msg("b7", FAILED, "I tried sending you the photo earlier but it didn't go through", 300),
                msg("b8", QUEUED, "trying again now", 20),
            ].into(),
            earlier: false,
        },
        Conversation {
            id: ConversationId("carol".into()),
            peer: "carol".into(),
            unread: 2,
            messages: vec![
                msg("c1", DELIVERED, "lunch tomorrow?", 7_200),
                msg("c2", IN, "yes!", 5_400),
                msg("c3", IN, "the place by the canal?", 5_300),
            ].into(),
            earlier: false,
        },
        Conversation {
            id: ConversationId("dmitri_k".into()),
            peer: "dmitri_k".into(),
            unread: 0,
            messages: vec![msg("d1", IN, "sent the slides, let me know what you think", 86_400 * 2)].into(),
            earlier: false,
        },
        Conversation {
            id: ConversationId("ines".into()),
            peer: "ines".into(),
            unread: 0,
            messages: vec![msg("i1", DELIVERED, "thanks for today", 86_400 * 4)].into(),
            earlier: false,
        },
    ]
}

pub fn starting(ui: &mut Ui) {
    ui.publish(Model::STARTING);
}

pub fn welcome(ui: &mut Ui) {
    ui.publish(Model { phase: Phase::EnterHandle(EnterHandle { lookup: HandleLookup::Idle }) });
}

pub fn welcome_error(ui: &mut Ui) {
    ui.handle_field.replace_text("bobby");
    ui.publish(Model {
        phase: Phase::EnterHandle(EnterHandle { lookup: HandleLookup::Failed { handle: "bobby".into(), error: LookupError::NotFound } }),
    });
}

pub fn pairing(ui: &mut Ui) {
    ui.publish(Model {
        phase: Phase::Pairing(Pairing { handle: HANDLE.into(), offer: Some(offer(Duration::from_secs(272))), relay: RelayStatus::Connected }),
    });
}

pub fn pairing_preparing(ui: &mut Ui) {
    ui.publish(Model { phase: Phase::Pairing(Pairing { handle: HANDLE.into(), offer: None, relay: RelayStatus::Connecting }) });
}

pub fn pairing_expired(ui: &mut Ui) {
    let mut o = offer(Duration::ZERO);
    o.expires_at = SystemTime::now() - Duration::from_secs(5);
    ui.publish(Model { phase: Phase::Pairing(Pairing { handle: HANDLE.into(), offer: Some(o), relay: RelayStatus::LocalOnly }) });
}

pub fn linking(ui: &mut Ui) {
    ui.publish(Model {
        phase: Phase::AwaitingEnrollment(AwaitingEnrollment {
            handle: HANDLE.into(),
            progress: EnrollmentProgress::Submitted,
            recovery: None,
            relay: RelayStatus::Connected,
            trouble: None,
        }),
    });
}

pub fn linking_recovery(ui: &mut Ui) {
    ui.publish(Model {
        phase: Phase::AwaitingEnrollment(AwaitingEnrollment {
            handle: HANDLE.into(),
            progress: EnrollmentProgress::Approved,
            recovery: Some(offer(Duration::from_secs(181))),
            relay: RelayStatus::Connected,
            trouble: None,
        }),
    });
}

pub fn linked_empty(ui: &mut Ui) {
    ui.publish(Model { phase: Phase::Linked(linked(Vec::new())) });
}

pub fn linked_list(ui: &mut Ui) {
    ui.publish(Model { phase: Phase::Linked(linked(conversations())) });
}

pub fn chat(ui: &mut Ui) {
    linked_list(ui);
    ui.selected = Some(ConversationId("bob".into()));
}

pub fn chat_verifying(ui: &mut Ui) {
    chat(ui);
    ui.update_model(|m| {
        if let Phase::Linked(l) = &mut m.phase {
            l.messaging = Messaging::Verifying;
            l.relay = RelayStatus::Connecting;
        }
    });
}

pub fn new_chat(ui: &mut Ui) {
    linked_list(ui);
    ui.pane = Pane::NewChat;
    ui.new_chat_field.replace_text("zoe");
    ui.update_model(|m| {
        if let Phase::Linked(l) = &mut m.phase {
            l.new_chat = NewChat::Lookup(HandleLookup::Failed { handle: "zoe".into(), error: LookupError::NotFound });
        }
    });
}

pub fn settings(ui: &mut Ui) {
    linked_list(ui);
    ui.pane = Pane::Settings;
}

pub fn revoked(ui: &mut Ui) {
    ui.publish(Model { phase: Phase::Revoked(Revoked { handle: HANDLE.into() }) });
}

/// The stored state of `QOP_DATA_DIR` (never the default directory), first chat open: a real
/// run rendered headless, e.g. after an e2e run. Not part of `scripts/snapshots.sh`.
pub fn live(ui: &mut Ui) {
    let model = std::env::var_os("QOP_DATA_DIR")
        .and_then(|dir| qop_desktop::engine::stored_model(std::path::Path::new(&dir)));
    let Some(model) = model else { return starting(ui) };
    let first = match &model.phase {
        Phase::Linked(l) => l.conversations.first().map(|c| c.id.clone()),
        _ => None,
    };
    ui.publish(model);
    ui.selected = first;
}

/// Sets up a scene on a fresh `Ui`.
type Scene = fn(&mut Ui);

/// Every scene, by name, for `--scene`.
pub const SCENES: &[(&str, Scene)] = &[
    ("starting", starting),
    ("welcome", welcome),
    ("welcome-error", welcome_error),
    ("pairing", pairing),
    ("pairing-preparing", pairing_preparing),
    ("pairing-expired", pairing_expired),
    ("linking", linking),
    ("linking-recovery", linking_recovery),
    ("linked-empty", linked_empty),
    ("linked", linked_list),
    ("chat", chat),
    ("chat-verifying", chat_verifying),
    ("new-chat", new_chat),
    ("settings", settings),
    ("revoked", revoked),
    ("live", live),
];
