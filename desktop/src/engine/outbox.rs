//! The outbox (`cli/src/outbox.ts`): every message is saved `queued` before any network IO and
//! becomes `sent` only after the recipient's ACK. A failed attempt stays `queued` with
//! exponential backoff (2 s doubling to 1 min); the only `failed` outcome is a handle that now
//! belongs to another account. Retry queues a failed message again.
//!
//! The engine owns scheduling: it flushes due records on every tick while messaging is ready,
//! one task per recipient (at most [`FLUSH_CONCURRENCY`]), and ignores backoff for a recipient
//! that just showed up online.

use super::Chain;
use super::auth::Contact;
use super::chat::{self, ChatContext};
use crate::keys::random_32;
use crate::store::StoreError;
use crate::wire::{ChatFrame, OutboxRecord, OutboxStatus};

const INITIAL_BACKOFF_MS: u64 = 2_000;
const MAX_BACKOFF_MS: u64 = 60_000;
/// Recipients delivered to at once (`OUTBOX_FLUSH_CONCURRENCY`).
pub const FLUSH_CONCURRENCY: usize = 8;

/// A freshly queued record for `frame` (`newOutboxRecord`).
pub fn new_record(frame: ChatFrame, to_handle: &str, to_qid: &str, now: u64) -> OutboxRecord {
    OutboxRecord {
        attempts: 0,
        frame,
        last_error: None,
        next_attempt_at: now,
        queued_at: now,
        status: OutboxStatus::Queued,
        to_handle: to_handle.into(),
        to_qid: to_qid.into(),
        updated_at: now,
    }
}

/// A random (v4) UUID, lowercase like `crypto.randomUUID`.
pub fn new_message_id() -> String {
    let mut bytes = random_32();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = alloy_primitives::hex::encode(&bytes[..16]);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

/// Jitter-free exponential backoff after `attempts` failures (`nextAttemptDelayMs`).
pub fn next_attempt_delay_ms(attempts: u64) -> u64 {
    if attempts < 1 {
        return 0;
    }
    let shift = (attempts - 1).min(16);
    (INITIAL_BACKOFF_MS << shift).min(MAX_BACKOFF_MS)
}

/// A failed attempt: still queued, retried after the backoff (`markWaiting`).
pub fn waiting(record: &OutboxRecord, note: &str, now: u64) -> OutboxRecord {
    let attempts = record.attempts + 1;
    OutboxRecord {
        attempts,
        last_error: Some(note.into()),
        next_attempt_at: now + next_attempt_delay_ms(attempts),
        status: OutboxStatus::Queued,
        updated_at: now,
        ..record.clone()
    }
}

/// Queued again by the user: due now, with a fresh attempt count.
pub fn retried(record: &OutboxRecord, now: u64) -> OutboxRecord {
    OutboxRecord {
        attempts: 0,
        last_error: None,
        next_attempt_at: now,
        status: OutboxStatus::Queued,
        updated_at: now,
        ..record.clone()
    }
}

/// How one delivery attempt ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// No longer queued (sent, failed or gone meanwhile).
    Skipped,
    Sent,
    /// Still queued; `pauses` asks the engine to re-verify its own membership.
    Waiting {
        pauses: bool,
    },
    Failed,
}

/// One attempt at the queued record `id` (`deliverOne`).
pub async fn deliver_one<C: Chain>(
    ctx: &ChatContext<C>,
    id: &str,
    now_ms: impl Fn() -> u64,
) -> Result<Outcome, StoreError> {
    let Some(latest) = ctx
        .store()
        .outbox(id)?
        .filter(|record| record.status == OutboxStatus::Queued)
    else {
        return Ok(Outcome::Skipped);
    };
    let wait = |note: &str, pauses: bool| -> Result<Outcome, StoreError> {
        ctx.store().put(&waiting(&latest, note, now_ms()))?;
        Ok(Outcome::Waiting { pauses })
    };
    if !ctx.auth.allowed() {
        return wait("unauthorized", false);
    }
    let account = match ctx.chain.lookup_handle(latest.to_handle.clone()).await {
        Ok(Some(account)) => account,
        Ok(None) => return wait("Account was not found.", false),
        Err(_) => return wait("rpc", false),
    };
    if account.handle != latest.to_handle || account.qid.to_string() != latest.to_qid {
        let failed = OutboxRecord {
            last_error: Some("Handle now belongs to a different account.".into()),
            status: OutboxStatus::Failed,
            updated_at: now_ms(),
            ..latest
        };
        ctx.store().put(&failed)?;
        return Ok(Outcome::Failed);
    }
    let recipient = Contact {
        qid: account.qid,
        handle: account.handle.clone(),
    };
    match chat::deliver(ctx, &recipient, &latest.frame, &account).await {
        Ok(()) => {
            let sent = OutboxRecord {
                last_error: None,
                status: OutboxStatus::Sent,
                updated_at: now_ms(),
                ..latest
            };
            ctx.store().put(&sent)?;
            Ok(Outcome::Sent)
        }
        Err(error) => wait(error.note(), error.pauses()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backs_off_exponentially_up_to_a_minute() {
        let delays: Vec<u64> = (0..8).map(next_attempt_delay_ms).collect();
        assert_eq!(
            delays,
            [0, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]
        );
        assert_eq!(next_attempt_delay_ms(1_000_000), 60_000);
    }

    #[test]
    fn message_ids_are_v4_uuids_chat_frames_accept() {
        let id = new_message_id();
        assert_ne!(id, new_message_id());
        let frame = ChatFrame {
            from_handle: "alice".into(),
            id: id.clone(),
            sent_at: 1,
            text: "hi".into(),
        };
        assert!(frame.encode().is_ok(), "{id}");
        assert_eq!(&id[14..15], "4");
    }
}
