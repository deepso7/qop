//! `/qop/chat/2` in and out (`cli/src/chat.ts`). One stream carries one signed, device-sealed
//! envelope; the recipient saves the decrypted chat frame and answers with a `ChatAckV1`.
//!
//! - Inbound: read to EOF, open the envelope, authorize the sender on the stream's own
//!   connection for the handle the frame claims, save to the inbox, and only then ACK.
//! - Outbound: dial the recipient's devices concurrently; the first stream whose peer verifies
//!   as the account the user chose (QID included) wins and the rest are reset. Authorization is
//!   rechecked immediately before writing; the message counts as delivered only on a matching
//!   ACK. Nothing is retried after the frame is written; the outbox decides what happens next.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::task::JoinSet;
use tokio::time::timeout;

use super::Chain;
use super::auth::{Auth, Contact, VerifyError};
use super::mailbox;
use crate::node::{NodeError, NodeHandle, Stream};
use crate::rpc::Account;
use crate::store::{Store, StoreError};
use crate::wire::chat_envelope::{ChatCipher, MAX_CHAT_ENVELOPE_BYTES};
use crate::wire::identity::device_key_from_peer;
use crate::wire::{CHAT_PROTOCOL, ChatAck, ChatFrame, InboxRecord, MAX_CHAT_PAYLOAD_BYTES};

/// Inbound chat streams and handlers served at once, including verification after a reset.
pub const MAX_INBOUND_STREAMS: usize = 8;
const INBOUND_READ_TIMEOUT: Duration = Duration::from_secs(15);
const ACK_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Hard bound on dialing the roster, before anything is written (`CHAT_DIAL_BUDGET_MS`).
const DIAL_BUDGET: Duration = Duration::from_secs(30);

/// What chat runs against. Cheap to clone into tasks.
#[derive(Clone)]
pub struct ChatContext<C> {
    pub node: NodeHandle,
    pub cipher: Arc<ChatCipher>,
    pub auth: Arc<Auth>,
    pub chain: C,
    pub store: Arc<Mutex<Store>>,
    pub mailboxes: Vec<String>,
}

impl<C> ChatContext<C> {
    pub fn store(&self) -> std::sync::MutexGuard<'_, Store> {
        self.store.lock().expect("store lock")
    }
}

/// Why an inbound stream was dropped; it has been reset, so the sender keeps it queued.
#[derive(Debug)]
pub enum InboundError {
    Read(NodeError),
    Timeout,
    Frame,
    /// Messaging is paused (own membership unverified, or a lifecycle invalidation).
    Paused,
    Unverified(VerifyError),
    Store(StoreError),
}

/// A message saved from `from_qid`; `inserted` is false for a repeat the sender resent.
#[derive(Debug)]
pub struct Received {
    pub from_qid: String,
    pub inserted: bool,
}

/// Serves one inbound chat stream.
pub async fn serve_inbound<C: Chain>(
    mut stream: Stream,
    ctx: &ChatContext<C>,
    now_ms: impl Fn() -> u64,
) -> Result<Received, InboundError> {
    let result = receive(&mut stream, ctx, now_ms).await;
    if result.is_err() {
        stream.reset();
    }
    result
}

async fn receive<C: Chain>(
    stream: &mut Stream,
    ctx: &ChatContext<C>,
    now_ms: impl Fn() -> u64,
) -> Result<Received, InboundError> {
    let bytes = timeout(
        INBOUND_READ_TIMEOUT,
        stream.read_to_end(MAX_CHAT_ENVELOPE_BYTES),
    )
    .await
    .map_err(|_| InboundError::Timeout)?
    .map_err(InboundError::Read)?;
    if !ctx.auth.allowed() {
        return Err(InboundError::Paused);
    }
    let (conn, peer) = (stream.conn(), stream.peer);
    let sender = device_key_from_peer(&peer).ok_or(InboundError::Frame)?;
    let frame = ctx
        .cipher
        .open(&bytes, &sender.0)
        .map_err(|_| InboundError::Frame)?;
    ctx.auth.opened(conn, &peer);
    let contact = ctx
        .auth
        .verify(&ctx.chain, conn, &peer, &frame.from_handle)
        .await
        .map_err(InboundError::Unverified)?;
    if !ctx.auth.allowed() || !ctx.auth.is_verified(conn, &peer, contact.qid) {
        return Err(InboundError::Paused);
    }
    let ack = ChatAck {
        ack: frame.id.clone(),
    }
    .encode()
    .map_err(|_| InboundError::Frame)?;
    let record = InboxRecord {
        frame,
        from_qid: contact.qid.to_string(),
        received_at: now_ms(),
    };
    let inserted = ctx
        .store()
        .put_inbox(&record)
        .map_err(InboundError::Store)?;
    // Saved: the engine must hear of it even if the ACK is lost (the sender resends, and a
    // repeat is not inserted twice).
    // Bounded: a write waits while the node's write budget is full.
    match timeout(ACK_TIMEOUT, stream.send_message(ack)).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => eprintln!("qop: chat ack not written: {error:?}"),
        Err(_) => eprintln!("qop: chat ack not written: timed out"),
    }
    Ok(Received {
        from_qid: record.from_qid,
        inserted,
    })
}

/// Why a delivery attempt failed (`CliOutboxDeliverError`, plus what the desktop pauses on).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeliverError {
    Timeout,
    /// No device reachable, or the stream failed before the frame was written.
    Transport,
    /// Authorization was gone by the time of writing.
    Unauthorized,
    /// No dialed device verified as the recipient.
    Unverified(VerifyError),
    /// The recipient's stream ended without a matching ACK after we wrote: it may have refused
    /// to authorize us.
    Rejected,
}

impl DeliverError {
    /// The outbox's `lastError` note.
    pub fn note(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Transport => "transport",
            Self::Unauthorized => "unauthorized",
            Self::Unverified(VerifyError::Rpc) => "rpc",
            Self::Unverified(VerifyError::Stale) => "stale registry head",
            Self::Unverified(_) => "recipient not verified",
            Self::Rejected => "rejected",
        }
    }

    /// Whether this failure should pause messaging and re-read our own membership: a peer
    /// rejecting us, or a chain read that failed or did not move.
    pub fn pauses(self) -> bool {
        match self {
            Self::Rejected => true,
            Self::Unverified(error) => error.pauses(),
            _ => false,
        }
    }
}

impl DeliverError {
    /// Whether this failure says the recipient's identity/authorization was rejected or messaging
    /// must pause, so mailbox fallback must not mask it with cached membership.
    fn blocks_mailbox_fallback(&self) -> bool {
        self.pauses()
            || matches!(
                self,
                Self::Unauthorized | Self::Unverified(VerifyError::Identity)
            )
    }

    fn dial_priority(&self) -> u8 {
        if self.pauses() {
            3
        } else if self.blocks_mailbox_fallback() {
            2
        } else if matches!(self, Self::Timeout) {
            1
        } else {
            0
        }
    }
}

/// Delivers `frame` to `recipient`, whose handle `account` was looked up under `auth_epoch`.
pub async fn deliver<C: Chain>(
    ctx: &ChatContext<C>,
    recipient: &Contact,
    frame: &ChatFrame,
    account: &Account,
    auth_epoch: u64,
) -> Result<(), DeliverError> {
    if !ctx.auth.allowed_at(auth_epoch) {
        return Err(DeliverError::Unauthorized);
    }

    match deliver_direct(ctx, recipient, frame, account).await {
        Ok((delivered_device, rejected_devices, saw_pause)) => {
            if !saw_pause && !ctx.mailboxes.is_empty() && ctx.auth.allowed_at(auth_epoch) {
                let remaining: Vec<_> = account
                    .devices
                    .iter()
                    .copied()
                    .filter(|device| {
                        *device != delivered_device && !rejected_devices.contains(device)
                    })
                    .collect();
                if !remaining.is_empty() {
                    // Best-effort background fan-out so a slow/down mailbox never stalls live chat.
                    let node = ctx.node.clone();
                    let mailboxes = ctx.mailboxes.clone();
                    let cipher = ctx.cipher.clone();
                    let auth = ctx.auth.clone();
                    let frame = frame.clone();
                    tokio::spawn(async move {
                        let _ = mailbox::deposit(
                            &node,
                            &mailboxes,
                            &cipher,
                            &auth,
                            auth_epoch,
                            &frame,
                            &remaining,
                        )
                        .await;
                    });
                }
            }
            Ok(())
        }
        Err((direct_error, rejected_devices)) => {
            // Never mask auth/revocation/stale-chain errors or a mid-flight invalidation behind a mailbox deposit.
            if !ctx.auth.allowed_at(auth_epoch) {
                return Err(DeliverError::Unauthorized);
            }
            let eligible_devices: Vec<_> = account
                .devices
                .iter()
                .copied()
                .filter(|device| !rejected_devices.contains(device))
                .collect();
            if !direct_error.blocks_mailbox_fallback()
                && !ctx.mailboxes.is_empty()
                && !eligible_devices.is_empty()
                && mailbox::deposit(
                    &ctx.node,
                    &ctx.mailboxes,
                    &ctx.cipher,
                    &ctx.auth,
                    auth_epoch,
                    frame,
                    &eligible_devices,
                )
                .await
            {
                return Ok(());
            }
            Err(direct_error)
        }
    }
}

async fn deliver_direct<C: Chain>(
    ctx: &ChatContext<C>,
    recipient: &Contact,
    frame: &ChatFrame,
    account: &Account,
) -> Result<
    (
        alloy_primitives::B256,
        std::collections::HashSet<alloy_primitives::B256>,
        bool,
    ),
    (DeliverError, std::collections::HashSet<alloy_primitives::B256>),
> {
    let peers = ctx.auth.recipient_peers(recipient, account);
    let (mut stream, rejected_devices, saw_pause) = first_authorized(ctx, recipient, peers).await?;
    let Some(delivered_device) = device_key_from_peer(&stream.peer) else {
        stream.reset();
        return Err((DeliverError::Transport, rejected_devices));
    };
    let Ok(envelope) = ctx.cipher.seal(frame, &delivered_device.0) else {
        stream.reset();
        return Err((DeliverError::Transport, rejected_devices));
    };
    // Recheck immediately before writing: a sleep or stall may have invalidated it.
    if !ctx.auth.allowed()
        || !ctx
            .auth
            .is_verified(stream.conn(), &stream.peer, recipient.qid)
    {
        stream.reset();
        return Err((DeliverError::Unauthorized, rejected_devices));
    }
    let result = exchange(&mut stream, envelope, &frame.id).await;
    if result.is_err() {
        stream.reset();
    }
    match result {
        Ok(()) => Ok((delivered_device, rejected_devices, saw_pause)),
        Err(error) => Err((error, rejected_devices)),
    }
}

/// Writes the frame and reads the ACK, both within `ACK_TIMEOUT`: a write waits while the node's
/// write budget is full, and a stuck delivery would hold its outbox slot.
async fn exchange(stream: &mut Stream, frame: Vec<u8>, id: &str) -> Result<(), DeliverError> {
    let ack = timeout(ACK_TIMEOUT, async {
        stream
            .send_message(frame)
            .await
            .map_err(|_| DeliverError::Transport)?;
        stream
            .read_to_end(MAX_CHAT_PAYLOAD_BYTES)
            .await
            .map_err(|_| DeliverError::Rejected)
    })
    .await
    .map_err(|_| DeliverError::Timeout)??;
    match ChatAck::decode(&ack) {
        Ok(ack) if ack.ack == id => Ok(()),
        _ => Err(DeliverError::Rejected),
    }
}

/// Dials every peer at once; the first authorized stream wins. Dropping the set aborts the other
/// dials, and any stream they still hold resets. Preserves observed pause or identity/auth
/// rejections across later transport failures, the outer dial budget, and surviving fan-out/fallback.
async fn first_authorized<C: Chain>(
    ctx: &ChatContext<C>,
    recipient: &Contact,
    peers: Vec<minip2p::PeerId>,
) -> Result<
    (
        Stream,
        std::collections::HashSet<alloy_primitives::B256>,
        bool,
    ),
    (DeliverError, std::collections::HashSet<alloy_primitives::B256>),
> {
    let mut dials = JoinSet::new();
    for peer in peers {
        let (ctx, recipient) = (ctx.clone(), recipient.clone());
        let device_key = device_key_from_peer(&peer);
        dials.spawn(async move { (device_key, dial(&ctx, &recipient, &peer).await) });
    }
    let mut error = DeliverError::Transport;
    let mut rejected_devices = std::collections::HashSet::new();
    let mut saw_pause = false;
    let deadline = tokio::time::Instant::now() + DIAL_BUDGET;
    loop {
        match tokio::time::timeout_at(deadline, dials.join_next()).await {
            Ok(Some(Ok((_device_key, Ok(stream))))) => {
                return Ok((stream, rejected_devices, saw_pause));
            }
            Ok(Some(Ok((device_key, Err(failed))))) => {
                if failed.pauses() {
                    saw_pause = true;
                }
                if failed.blocks_mailbox_fallback()
                    && let Some(key) = device_key
                {
                    rejected_devices.insert(key);
                }
                if failed.dial_priority() >= error.dial_priority() {
                    error = failed;
                }
            }
            Ok(Some(Err(_))) => {}
            Ok(None) => return Err((error, rejected_devices)),
            Err(_) => {
                let final_error = if error.blocks_mailbox_fallback() {
                    error
                } else {
                    DeliverError::Timeout
                };
                return Err((final_error, rejected_devices));
            }
        }
    }
}

async fn dial<C: Chain>(
    ctx: &ChatContext<C>,
    recipient: &Contact,
    peer: &minip2p::PeerId,
) -> Result<Stream, DeliverError> {
    let stream = open(&ctx.node, peer).await?;
    let (conn, peer) = (stream.conn(), stream.peer);
    ctx.auth.opened(conn, &peer);
    let contact = ctx
        .auth
        .verify(&ctx.chain, conn, &peer, &recipient.handle)
        .await
        .map_err(DeliverError::Unverified)?;
    // Chat frames name no recipient: bind to the account the user chose, not whichever account
    // the device belongs to now.
    if contact.qid != recipient.qid {
        return Err(DeliverError::Unverified(VerifyError::Identity));
    }
    if !ctx.auth.is_verified(conn, &peer, recipient.qid) {
        return Err(DeliverError::Unauthorized);
    }
    Ok(stream)
}

/// Connects and opens a chat stream; once more if the open fails (a relayed connection can be
/// replaced by a direct one mid-setup). Never after anything was written.
async fn open(node: &NodeHandle, peer: &minip2p::PeerId) -> Result<Stream, DeliverError> {
    for _ in 0..2 {
        timeout(CONNECT_TIMEOUT, node.connect_peer(peer))
            .await
            .map_err(|_| DeliverError::Timeout)?
            .map_err(|_| DeliverError::Transport)?;
        if let Ok(stream) = timeout(CONNECT_TIMEOUT, node.open_stream(peer, CHAT_PROTOCOL))
            .await
            .map_err(|_| DeliverError::Timeout)?
        {
            return Ok(stream);
        }
    }
    Err(DeliverError::Transport)
}
