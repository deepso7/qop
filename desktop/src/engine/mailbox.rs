//! Mailbox store-and-forward client over `/qop/mailbox/1`.

use std::collections::HashSet;
use std::str::FromStr;
use std::time::Duration;

use alloy_primitives::B256;
use minip2p::PeerId;
use tokio::time::timeout;

use super::Chain;
use super::auth::Auth;
use super::chat::{ChatContext, Received};
use crate::node::{NodeHandle, Stream};
use crate::store::StoreError;
use crate::wire::chat_envelope::ChatCipher;
use crate::wire::mailbox::{
    MAILBOX_MAX_DEPOSIT_ITEMS, MAILBOX_MAX_FETCH_LIMIT, MAILBOX_PROTOCOL,
    MAX_MAILBOX_PAYLOAD_BYTES, MailboxDepositItem, MailboxRequest, MailboxResponse, decode_base64,
    encode_base64,
};
use crate::wire::{ChatFrame, InboxRecord};

const MAILBOX_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_DRAIN_PAGES: usize = 16;

fn peer_id_from_addr(addr: &str) -> Option<PeerId> {
    let (_, peer_str) = addr.rsplit_once("/p2p/")?;
    PeerId::from_str(peer_str).ok()
}

async fn open_stream(node: &NodeHandle, addr: &str) -> Result<Stream, ()> {
    // Reuse an existing connection when possible so polls do not re-dial every tick.
    if let Some(peer) = peer_id_from_addr(addr)
        && let Ok(Ok(stream)) =
            timeout(MAILBOX_TIMEOUT, node.open_stream(&peer, MAILBOX_PROTOCOL)).await
    {
        return Ok(stream);
    }

    let peer = timeout(MAILBOX_TIMEOUT, node.connect(vec![addr.to_owned()]))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;
    timeout(MAILBOX_TIMEOUT, node.open_stream(&peer, MAILBOX_PROTOCOL))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}

async fn exchange(
    node: &NodeHandle,
    addr: &str,
    request: &MailboxRequest,
    auth: Option<(&Auth, Option<u64>)>,
) -> Result<MailboxResponse, ()> {
    let encoded = request.encode().map_err(|_| ())?;
    let mut stream = open_stream(node, addr).await?;

    // Recheck readiness and captured auth epoch immediately before writing so a lifecycle pause
    // or invalidation + re-ready cannot leak a deposit from a pre-invalidation roster.
    let auth_ok = match auth {
        Some((a, Some(epoch))) => a.allowed_at(epoch),
        Some((a, None)) => a.allowed(),
        None => true,
    };
    if !auth_ok {
        stream.reset();
        return Err(());
    }

    let outcome = timeout(MAILBOX_TIMEOUT, async {
        stream.send_message(encoded).await.map_err(|_| ())?;
        stream
            .read_to_end(MAX_MAILBOX_PAYLOAD_BYTES)
            .await
            .map_err(|_| ())
    })
    .await;

    match outcome {
        Ok(Ok(bytes)) => MailboxResponse::decode(&bytes).map_err(|_| ()),
        _ => {
            stream.reset();
            Err(())
        }
    }
}

/// Seal per-device HPKE envelopes and deposit them across configured mailboxes,
/// retrying only still-pending recipient devices on later mailboxes.
pub async fn deposit(
    node: &NodeHandle,
    mailboxes: &[String],
    cipher: &ChatCipher,
    auth: &Auth,
    auth_epoch: u64,
    frame: &ChatFrame,
    recipient_devices: &[B256],
) -> bool {
    let mut seen = HashSet::with_capacity(recipient_devices.len());
    let mut pending: Vec<MailboxDepositItem> = Vec::with_capacity(recipient_devices.len());
    for &device in recipient_devices {
        if !seen.insert(device) {
            continue;
        }
        let Ok(envelope) = cipher.seal(frame, &device.0) else {
            return false;
        };
        pending.push(MailboxDepositItem {
            envelope: encode_base64(&envelope),
            id: frame.id.clone(),
            recipient_device_key: device,
        });
    }

    if pending.is_empty() {
        return true;
    }
    if mailboxes.is_empty() || !auth.allowed_at(auth_epoch) {
        return false;
    }

    let mut accepted_any = false;

    for addr in mailboxes {
        if pending.is_empty() || !auth.allowed_at(auth_epoch) {
            break;
        }
        let mut accepted_keys = HashSet::new();
        for chunk in pending.chunks(MAILBOX_MAX_DEPOSIT_ITEMS) {
            let chunk_keys: HashSet<B256> =
                chunk.iter().map(|item| item.recipient_device_key).collect();
            let req = MailboxRequest::Deposit {
                items: chunk.to_vec(),
            };
            if let Ok(MailboxResponse::Deposited { items }) =
                exchange(node, addr, &req, Some((auth, Some(auth_epoch)))).await
            {
                for deposited in items {
                    if deposited.id == frame.id
                        && chunk_keys.contains(&deposited.recipient_device_key)
                    {
                        accepted_keys.insert(deposited.recipient_device_key);
                    }
                }
            }
        }
        if !accepted_keys.is_empty() {
            accepted_any = true;
            pending.retain(|item| !accepted_keys.contains(&item.recipient_device_key));
        }
    }

    accepted_any
}

/// Drain up to `MAX_DRAIN_PAGES` pages of pending envelopes concurrently across
/// all configured mailboxes, invoking `on_received` immediately after each local
/// insert (before ACK and independently of other mailboxes).
pub async fn drain_all<C: Chain + 'static>(
    ctx: &ChatContext<C>,
    now_ms: impl Fn() -> u64 + Send + Sync + Clone + 'static,
    on_received: impl Fn(Received) + Send + Sync + Clone + 'static,
) {
    if ctx.mailboxes.is_empty() || !ctx.auth.allowed() {
        return;
    }
    let Some(owning_device_key) = ctx.store().identity().ok().flatten().map(|id| id.device_key)
    else {
        return;
    };

    let mut tasks = tokio::task::JoinSet::new();
    for addr in ctx.mailboxes.clone() {
        let ctx = ctx.clone();
        let now_ms = now_ms.clone();
        let on_received = on_received.clone();
        tasks.spawn(async move {
            drain_one(&ctx, &addr, owning_device_key, &now_ms, &on_received).await;
        });
    }
    while tasks.join_next().await.is_some() {}
}

async fn drain_one<C: Chain>(
    ctx: &ChatContext<C>,
    addr: &str,
    owning_device_key: B256,
    now_ms: &impl Fn() -> u64,
    on_received: &impl Fn(Received),
) {
    let mut acked_seqs_seen = HashSet::new();
    for _ in 0..MAX_DRAIN_PAGES {
        if !ctx.auth.allowed() {
            break;
        }
        let fetch_req = MailboxRequest::Fetch {
            limit: MAILBOX_MAX_FETCH_LIMIT as u32,
        };
        let Ok(MailboxResponse::Messages { has_more, items }) =
            exchange(&ctx.node, addr, &fetch_req, Some((&ctx.auth, None))).await
        else {
            break;
        };
        if items.is_empty() {
            break;
        }

        let mut ack_seqs = Vec::with_capacity(items.len());
        let mut stop_mailbox = false;
        for item in items {
            if acked_seqs_seen.contains(&item.seq) {
                // Hostile or broken mailbox repeated an already-ACKed seq; abort loop.
                stop_mailbox = true;
                break;
            }
            let Ok(envelope_bytes) = decode_base64(&item.envelope) else {
                ack_seqs.push(item.seq);
                continue;
            };
            let Ok(frame) = ctx.cipher.open(&envelope_bytes, &item.sender_device_key.0) else {
                ack_seqs.push(item.seq);
                continue;
            };
            // Leave transient RPC failures unacknowledged so the next poll retries.
            let Ok(sender_account_opt) = ctx.chain.lookup_device_key(item.sender_device_key).await
            else {
                continue;
            };
            let Some(sender_account) = sender_account_opt else {
                // Unknown or revoked sender device; drop and ACK.
                ack_seqs.push(item.seq);
                continue;
            };
            if sender_account.handle != frame.from_handle {
                // Forged handle does not match the sender device's account; drop and ACK.
                ack_seqs.push(item.seq);
                continue;
            }

            // Re-check auth and owning identity atomically under the store lock so a
            // concurrent unlink/revoke wipe cannot have erased messages restored.
            if !ctx.auth.allowed() {
                stop_mailbox = true;
                break;
            }
            let store = ctx.store();
            let still_same_identity = store
                .identity()
                .ok()
                .flatten()
                .is_some_and(|id| id.device_key == owning_device_key);
            if !still_same_identity {
                stop_mailbox = true;
                break;
            }

            let record = InboxRecord {
                frame,
                from_qid: sender_account.qid.to_string(),
                received_at: now_ms(),
            };
            let saved = store.put_inbox(&record);
            drop(store);
            match saved {
                Ok(inserted) => {
                    ack_seqs.push(item.seq);
                    on_received(Received {
                        from_qid: record.from_qid,
                        inserted,
                    });
                }
                Err(StoreError::Conflict) => {
                    // Deterministic content conflict on an existing id: drop so it
                    // cannot head-of-line block subsequent messages.
                    ack_seqs.push(item.seq);
                }
                Err(_) => {
                    // Transient storage failure: leave unacked to retry later.
                }
            }
        }

        if stop_mailbox || ack_seqs.is_empty() {
            break;
        }
        let ack_req = MailboxRequest::Ack {
            seqs: ack_seqs.clone(),
        };
        if !matches!(
            exchange(&ctx.node, addr, &ack_req, Some((&ctx.auth, None))).await,
            Ok(MailboxResponse::Acked { .. })
        ) {
            break;
        }
        acked_seqs_seen.extend(ack_seqs);
        if !has_more {
            break;
        }
    }
}
