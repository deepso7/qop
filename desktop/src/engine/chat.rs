//! `/qop/chat/1` in and out (`cli/src/chat.ts`). One stream carries one exchange: the sender
//! writes a `ChatFrameV1` and half-closes, the recipient saves it and answers a `ChatAckV1`.
//!
//! - Inbound: read to EOF (16 KiB, 15 s), decode, authorize the sender on the stream's own
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
use crate::node::{NodeError, NodeHandle, Stream};
use crate::rpc::Account;
use crate::store::{Store, StoreError};
use crate::wire::{CHAT_PROTOCOL, ChatAck, ChatFrame, InboxRecord, MAX_CHAT_PAYLOAD_BYTES};

/// Inbound chat streams handled at once; more are reset (`MAX_INBOUND_STREAMS`).
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
    pub auth: Arc<Auth>,
    pub chain: C,
    pub store: Arc<Mutex<Store>>,
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

/// Serves one inbound `/qop/chat/1` stream.
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
        stream.read_to_end(MAX_CHAT_PAYLOAD_BYTES),
    )
    .await
    .map_err(|_| InboundError::Timeout)?
    .map_err(InboundError::Read)?;
    let frame = ChatFrame::decode(&bytes).map_err(|_| InboundError::Frame)?;
    if !ctx.auth.allowed() {
        return Err(InboundError::Paused);
    }
    let (conn, peer) = (stream.conn(), stream.peer.clone());
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

/// Delivers `frame` to `recipient`, whose handle `account` was just looked up as.
pub async fn deliver<C: Chain>(
    ctx: &ChatContext<C>,
    recipient: &Contact,
    frame: &ChatFrame,
    account: &Account,
) -> Result<(), DeliverError> {
    let bytes = frame.encode().map_err(|_| DeliverError::Transport)?;
    let peers = ctx.auth.recipient_peers(recipient, account);
    let mut stream = timeout(DIAL_BUDGET, first_authorized(ctx, recipient, peers))
        .await
        .map_err(|_| DeliverError::Timeout)??;
    // Recheck immediately before writing: a sleep or stall may have invalidated it.
    if !ctx.auth.allowed()
        || !ctx
            .auth
            .is_verified(stream.conn(), &stream.peer, recipient.qid)
    {
        stream.reset();
        return Err(DeliverError::Unauthorized);
    }
    let result = exchange(&mut stream, bytes, &frame.id).await;
    if result.is_err() {
        stream.reset();
    }
    result
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
/// dials, and any stream they still hold resets.
async fn first_authorized<C: Chain>(
    ctx: &ChatContext<C>,
    recipient: &Contact,
    peers: Vec<minip2p::PeerId>,
) -> Result<Stream, DeliverError> {
    let mut dials = JoinSet::new();
    for peer in peers {
        let (ctx, recipient) = (ctx.clone(), recipient.clone());
        dials.spawn(async move { dial(&ctx, &recipient, &peer).await });
    }
    let mut error = DeliverError::Transport;
    while let Some(joined) = dials.join_next().await {
        match joined {
            Ok(Ok(stream)) => return Ok(stream),
            // Keep the most telling failure: one that should pause wins.
            Ok(Err(failed)) if failed.pauses() || !error.pauses() => error = failed,
            _ => {}
        }
    }
    Err(error)
}

async fn dial<C: Chain>(
    ctx: &ChatContext<C>,
    recipient: &Contact,
    peer: &minip2p::PeerId,
) -> Result<Stream, DeliverError> {
    let stream = open(&ctx.node, peer).await?;
    let (conn, peer) = (stream.conn(), stream.peer.clone());
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
