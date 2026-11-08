//! The view model: plain data the engine publishes and the UI renders, and the commands the UI
//! sends back. Nothing here does IO; the engine owns every transition between phases.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

/// How long a pairing offer lives (`PAIRING_TTL_SECONDS` in `@qop/protocol`).
pub const PAIRING_TTL: Duration = Duration::from_secs(300);

/// Everything the engine publishes. The UI renders only from this (plus its own local state).
#[derive(Clone, Debug, PartialEq)]
pub struct Model {
    pub phase: Phase,
}

/// The device's place in the linking state machine (`docs/research/desktop-app-plan.md`).
#[derive(Clone, Debug, PartialEq)]
pub enum Phase {
    /// Opening the store and keychain; nothing to act on yet.
    Starting,
    /// No account yet: ask which handle to link to.
    EnterHandle(EnterHandle),
    /// Showing a pairing offer for the phone to scan.
    Pairing(Pairing),
    /// The phone approved; waiting for the chain to confirm membership.
    AwaitingEnrollment(AwaitingEnrollment),
    /// A member of the account: conversations and settings.
    Linked(Linked),
    /// A chain read showed this device was removed; local data is wiped.
    Revoked(Revoked),
}

/// The handle form, with the result of the last lookup.
#[derive(Clone, Debug, PartialEq)]
pub struct EnterHandle {
    pub lookup: HandleLookup,
}

/// The state of resolving a handle on chain (first launch and New chat share it).
#[derive(Clone, Debug, PartialEq)]
pub enum HandleLookup {
    /// Nothing submitted, or the last result was dismissed.
    Idle,
    /// Resolving `handle`.
    Resolving { handle: String },
    /// `handle` could not be used.
    Failed { handle: String, error: LookupError },
}

/// Why a handle lookup failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LookupError {
    /// Not a well-formed handle.
    Invalid,
    /// No account has this handle.
    NotFound,
    /// The chain or API could not be reached; trying again may work.
    Unreachable,
}

/// Pairing as a fresh device: show the offer until a phone claims it.
#[derive(Clone, Debug, PartialEq)]
pub struct Pairing {
    pub handle: String,
    /// `None` while the relay reservation (or LAN fallback) is still being set up.
    pub offer: Option<Offer>,
    pub relay: RelayStatus,
}

/// One pairing offer; it is dead after `expires_at`, and Regenerate replaces it.
#[derive(Clone, Debug, PartialEq)]
pub struct Offer {
    /// The full `qop-pair1.` payload, shown as a QR code and copied as text.
    pub code: String,
    /// The pairing fingerprint the phone shows too (`pairingFingerprint`), e.g. `9F3A21C4`.
    pub fingerprint: String,
    pub expires_at: SystemTime,
}

/// How reachable this device is for the phone and contacts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RelayStatus {
    /// Reserving a relay slot.
    Connecting,
    /// Reachable through a relay.
    Connected,
    /// No relay; reachable only on the local network.
    LocalOnly,
    /// No network at all.
    Offline,
}

/// Approved by the phone; the engine polls API status and chain membership.
#[derive(Clone, Debug, PartialEq)]
pub struct AwaitingEnrollment {
    pub handle: String,
    pub progress: EnrollmentProgress,
    /// `Some` after Stop waiting: progress is hidden and this recovery offer (same device key)
    /// is shown instead, in case the phone never received `approvalSaved`.
    pub recovery: Option<Offer>,
    pub relay: RelayStatus,
    /// What the last poll could not reach; progress may be stale meanwhile.
    pub trouble: Option<Unreachable>,
}

/// A service the engine could not reach on its last try. Never blocking: it retries on its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unreachable {
    /// The chain RPC (membership and contact verification).
    Chain,
    /// The device-action API (enrollment progress).
    Api,
}

/// How far the add-device intent has got, as the API reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum EnrollmentProgress {
    /// The approval is saved here; the phone has yet to submit it.
    Approved,
    /// The phone submitted the transaction.
    Submitted,
    /// The API saw it confirmed; waiting for this device's own chain read.
    Confirming,
}

/// A linked device: the account, its conversations and connectivity.
#[derive(Clone, Debug, PartialEq)]
pub struct Linked {
    pub account: Account,
    /// Most recent first.
    pub conversations: Vec<Conversation>,
    pub messaging: Messaging,
    pub relay: RelayStatus,
    /// Set while this device's own membership read fails to reach the chain.
    pub trouble: Option<Unreachable>,
    /// The last New chat lookup; `Resolved` names the conversation it opened.
    pub new_chat: NewChat,
}

/// Facts about this device and account, for Settings.
#[derive(Clone, Debug, PartialEq)]
pub struct Account {
    pub handle: String,
    pub peer_id: String,
    pub fingerprint: String,
    pub data_dir: PathBuf,
}

/// Whether this device may message right now. Verification failures pause, never wipe.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Messaging {
    Ready,
    /// Re-checking membership (after resume or a failed authorization); sends queue meanwhile.
    Verifying,
}

/// The result of the last New chat lookup.
#[derive(Clone, Debug, PartialEq)]
pub enum NewChat {
    Lookup(HandleLookup),
    /// `handle` resolved; its conversation (new or existing) is `conversation`.
    Resolved { handle: String, conversation: ConversationId },
}

/// Identifies a conversation (one per contact).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ConversationId(pub String);

/// Identifies a message (the outbox/inbox record ID).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct MessageId(pub String);

/// A chat with one contact.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Conversation {
    pub id: ConversationId,
    pub peer: String,
    pub unread: u32,
    /// The newest messages, oldest first: shared, so publishing a model copies no messages, and
    /// an unchanged conversation compares equal by pointer.
    pub messages: Arc<[Message]>,
    /// Older messages are stored than `messages` holds; [`Command::LoadEarlier`] adds a page.
    pub earlier: bool,
}

/// One chat message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    pub id: MessageId,
    pub direction: Direction,
    pub text: String,
    pub at: SystemTime,
}

/// Who wrote a message; only messages this account sent have a delivery status.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Received,
    Sent(MessageStatus),
}

/// Outbox status of a sent message (`OutboxRecordV1`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessageStatus {
    /// Saved, not yet acknowledged by the recipient.
    Queued,
    /// The recipient acknowledged it; shown as Delivered.
    Sent,
    /// Gave up; Retry queues it again.
    Failed,
}

/// The device has been removed from the account.
#[derive(Clone, Debug, PartialEq)]
pub struct Revoked {
    pub handle: String,
}

/// What the UI asks the engine to do.
#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    /// Resolve this handle and start pairing to its account.
    SubmitHandle(String),
    /// Replace the pairing (or recovery) offer with a fresh one.
    RegeneratePairing,
    /// Hide enrollment progress and show the recovery offer.
    StopWaiting,
    /// Forget the account and start over (allowed in Pairing and Linked only).
    Unlink,
    /// The user opened a conversation, or came back to it; mark it read, and what arrives in it
    /// while it is on screen.
    OpenConversation(ConversationId),
    /// The open conversation left the screen (Settings or New chat): stop marking it read.
    CloseConversation,
    /// Look up a handle and open (or create) its conversation.
    StartChat(String),
    /// Queue a message.
    Send { conversation: ConversationId, text: String },
    /// Queue a failed message again.
    Retry(MessageId),
    /// Show a page of older messages in this conversation.
    LoadEarlier(ConversationId),
    /// Leave the Revoked screen for a fresh start.
    AcknowledgeRevoked,
}

impl Model {
    /// The model before the engine has published anything.
    pub const STARTING: Model = Model { phase: Phase::Starting };
}

impl Linked {
    pub fn conversation(&self, id: &ConversationId) -> Option<&Conversation> {
        self.conversations.iter().find(|c| &c.id == id)
    }
}

impl Conversation {
    pub fn last(&self) -> Option<&Message> {
        self.messages.last()
    }
}
