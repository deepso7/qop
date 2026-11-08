//! `/qop/sync/1` from this account's own phone (`cli/src/sync.ts`). The phone writes one request
//! and half-closes; this device answers once:
//!
//! - `handoff`: a message the phone composed. Saved to the outbox before `held` is sent, so a
//!   `held` the phone sees is a message this device will deliver; the outbox does the rest.
//! - `poll`: receipts for the handed-off ids the outbox has marked `sent` (after the recipient's
//!   ACK).
//! - `catchup`: inbox records past the phone's cursor (the inbox rowid), packed under the
//!   64 KiB frame cap, so the phone sees what arrived here while it was away.
//!
//! Only an active device of this account may ask: the peer is verified, on the stream's own
//! connection, as a member of our own handle and QID, before the request is read, and again
//! (with the messaging gate) before anything is saved or answered. Any failure resets the stream.

use std::time::Duration;

use alloy_primitives::{B256, U256};
use tokio::time::timeout;

use super::Chain;
use super::auth::VerifyError;
use super::chat::ChatContext;
use crate::node::{NodeError, Stream};
use crate::store::{InboxPage, StoreError};
use crate::wire::{
    MAX_SYNC_PAYLOAD_BYTES, OutboxRecord, OutboxStatus, SyncCodecError, SyncErrorReason,
    SyncInboxItem, SyncReceipt, SyncRequest, SyncResponse, device_key_from_peer_id,
};

/// Rows read for one catch-up page before packing trims it (`INBOX_CATCHUP_ROW_LIMIT`).
pub const CATCHUP_ROW_LIMIT: usize = 64;
/// The whole exchange, verification included (the CLI's `INBOUND_READ_TIMEOUT_MS`).
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(15);

/// The account this device belongs to.
#[derive(Clone, Debug)]
pub struct Own {
    pub handle: String,
    pub qid: U256,
}

/// Why a sync stream was reset.
#[derive(Debug)]
pub enum SyncError {
    Read(NodeError),
    Timeout,
    Frame,
    /// Messaging is paused (own membership unverified, or a lifecycle invalidation).
    Paused,
    /// The peer is not (or no longer) an active device of this account.
    Unverified(VerifyError),
    Store(StoreError),
    Reply(NodeError),
}

/// What a served request changed here.
#[derive(Debug, PartialEq, Eq)]
pub enum Served {
    /// A handoff is in the outbox (new, or the phone repeating one), addressed to `to_qid`.
    Held { to_qid: String },
    /// Nothing: an answer from what is stored, or a refused handoff.
    Answered,
}

/// Serves one inbound `/qop/sync/1` stream.
pub async fn serve<C: Chain>(
    mut stream: Stream,
    ctx: &ChatContext<C>,
    own: &Own,
) -> Result<Served, SyncError> {
    let result = timeout(EXCHANGE_TIMEOUT, exchange(&mut stream, ctx, own))
        .await
        .unwrap_or(Err(SyncError::Timeout));
    if result.is_err() {
        stream.reset();
    }
    result
}

async fn exchange<C: Chain>(
    stream: &mut Stream,
    ctx: &ChatContext<C>,
    own: &Own,
) -> Result<Served, SyncError> {
    if !ctx.auth.allowed() {
        return Err(SyncError::Paused);
    }
    let (conn, peer) = (stream.conn(), stream.peer.clone());
    ctx.auth.opened(conn, &peer);
    let contact = ctx
        .auth
        .verify(&ctx.chain, conn, &peer, &own.handle)
        .await
        .map_err(SyncError::Unverified)?;
    if contact.qid != own.qid || !ctx.auth.is_verified(conn, &peer, own.qid) {
        return Err(SyncError::Unverified(VerifyError::Identity));
    }
    let bytes = stream
        .read_to_end(MAX_SYNC_PAYLOAD_BYTES)
        .await
        .map_err(SyncError::Read)?;
    let request = SyncRequest::decode(&bytes).map_err(|_| SyncError::Frame)?;
    // Recheck at the persist/answer boundary: a sleep or stall may have invalidated meanwhile.
    if !ctx.auth.allowed() || !ctx.auth.is_verified(conn, &peer, own.qid) {
        return Err(SyncError::Paused);
    }
    let peer_key = device_key_from_peer_id(&peer.to_base58())
        .ok_or(SyncError::Unverified(VerifyError::Identity))?;
    let (response, served) = match request {
        SyncRequest::Handoff {
            composed_by,
            record,
        } => {
            let response = accept_handoff(ctx, own, &record, composed_by, peer_key);
            let served = match response {
                SyncResponse::Held { .. } => Served::Held {
                    to_qid: record.to_qid,
                },
                _ => Served::Answered,
            };
            (response, served)
        }
        SyncRequest::Catchup { after } => {
            let page = ctx
                .store()
                .inbox_after(after, CATCHUP_ROW_LIMIT)
                .map_err(SyncError::Store)?;
            (pack_inbox(page)?, Served::Answered)
        }
        SyncRequest::Poll { ids } => {
            let records = ctx.store().outbox_by_ids(&ids).map_err(SyncError::Store)?;
            (receipts(&records), Served::Answered)
        }
    };
    let bytes = response.encode().map_err(|_| SyncError::Frame)?;
    stream.send_message(bytes).await.map_err(SyncError::Reply)?;
    Ok(served)
}

fn error(reason: SyncErrorReason) -> SyncResponse {
    SyncResponse::Error { reason }
}

/// `acceptHandoff`: only our own queued message to someone else, composed by the peer itself,
/// that fits a chat frame (a sync request has room for a frame `chat::deliver` would refuse).
/// A store failure is answered, not reset: a reset after the request looks like a lost `held`,
/// and the phone would think this device holds it.
fn accept_handoff<C>(
    ctx: &ChatContext<C>,
    own: &Own,
    record: &OutboxRecord,
    composed_by: B256,
    peer_key: B256,
) -> SyncResponse {
    if composed_by != peer_key
        || record.frame.from_handle != own.handle
        || record.to_qid == own.qid.to_string()
        || record.status != OutboxStatus::Queued
        || record.frame.encode().is_err()
    {
        return error(SyncErrorReason::Invalid);
    }
    match ctx.store().enqueue(record) {
        // An earlier copy that failed for good must not look like a live hold.
        Ok(saved) if saved.status == OutboxStatus::Failed => error(SyncErrorReason::Invalid),
        Ok(saved) => SyncResponse::Held { id: saved.frame.id },
        Err(StoreError::Conflict) => error(SyncErrorReason::Conflict),
        Err(_) => error(SyncErrorReason::Unavailable),
    }
}

/// Receipts for the records delivered so far; `updated_at` is when the ACK was recorded.
fn receipts(records: &[OutboxRecord]) -> SyncResponse {
    SyncResponse::Receipts {
        receipts: records
            .iter()
            .filter(|record| record.status == OutboxStatus::Sent)
            .map(|record| SyncReceipt {
                delivered_at: record.updated_at,
                id: record.frame.id.clone(),
                to_qid: record.to_qid.clone(),
            })
            .collect(),
    }
}

/// `packInbox`: greedy by encoded size. The first row always goes in (one row fits by
/// construction); later rows stop at the frame cap.
fn pack_inbox(page: InboxPage) -> Result<SyncResponse, SyncError> {
    let mut packed = SyncResponse::Inbox {
        last_seq: page.last_seq,
        records: Vec::with_capacity(page.records.len()),
    };
    for (seq, record) in page.records {
        items(&mut packed).push(SyncInboxItem { record, seq });
        match packed.encode() {
            Ok(_) => {}
            Err(SyncCodecError::Oversized) if items(&mut packed).len() > 1 => {
                items(&mut packed).pop();
                break;
            }
            Err(_) => return Err(SyncError::Frame),
        }
    }
    Ok(packed)
}

fn items(inbox: &mut SyncResponse) -> &mut Vec<SyncInboxItem> {
    match inbox {
        SyncResponse::Inbox { records, .. } => records,
        _ => unreachable!("packing an inbox page"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{ChatFrame, InboxRecord};

    /// An inbox record whose text is `emoji` four-byte characters (two UTF-16 units each).
    fn record(seq: u64, emoji: usize) -> (u64, InboxRecord) {
        let record = InboxRecord {
            frame: ChatFrame {
                from_handle: "bob".into(),
                id: format!("0b0b0b0b-0000-4000-8000-{seq:012}"),
                sent_at: 1,
                text: "😀".repeat(emoji),
            },
            from_qid: "7".into(),
            received_at: 2,
        };
        (seq, record)
    }

    fn packed_seqs(response: &SyncResponse) -> Vec<u64> {
        match response {
            SyncResponse::Inbox { records, .. } => records.iter().map(|item| item.seq).collect(),
            other => panic!("not an inbox page: {other:?}"),
        }
    }

    #[test]
    fn packs_catch_up_pages_under_the_frame_cap() {
        // Ten max-size messages (8 KB each) are more than 64 KiB: a prefix of them is packed.
        let page = InboxPage {
            last_seq: 10,
            records: (1..=10).map(|seq| record(seq, 2_000)).collect(),
        };
        let packed = pack_inbox(page).unwrap();
        let seqs = packed_seqs(&packed);
        assert!((2..10).contains(&seqs.len()), "{seqs:?}");
        assert_eq!(seqs, (1..=seqs.len() as u64).collect::<Vec<_>>());
        assert!(packed.encode().unwrap().len() <= MAX_SYNC_PAYLOAD_BYTES);

        let small = InboxPage {
            last_seq: 3,
            records: vec![record(1, 10), record(2, 10), record(3, 10)],
        };
        assert_eq!(packed_seqs(&pack_inbox(small).unwrap()), [1, 2, 3]);
        let empty = InboxPage {
            last_seq: 3,
            records: vec![],
        };
        assert_eq!(
            pack_inbox(empty).unwrap(),
            SyncResponse::Inbox {
                last_seq: 3,
                records: vec![]
            }
        );
    }
}
