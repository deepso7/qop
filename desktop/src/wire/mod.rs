//! Pure Rust port of the identity and protocol wire formats a linked device
//! uses (`@qop/identity`, `@qop/protocol`). No IO: codecs take and return
//! bytes; [`framing`] turns stream chunks into messages.
//!
//! Each decoder accepts and rejects exactly what its TS counterpart does,
//! including whether unknown fields are allowed: pairing and sync are strict,
//! chat frames, chat ACKs and API status responses are lenient. Encoders
//! validate like the TS schema encode and emit the same bytes.

pub mod approval;
pub mod chat;
pub mod eip712;
pub mod framing;
pub mod identity;
pub(crate) mod json;
pub mod pairing;
pub mod status;
pub mod sync;

pub use approval::{ApprovalError, ApprovalOperation, DeviceActionApproval};
pub use chat::{CHAT_PROTOCOL, ChatAck, ChatError, ChatFrame, MAX_CHAT_PAYLOAD_BYTES};
pub use eip712::{DeviceIntent, EcdsaSignature, IdentityDomain, IntentError};
pub use framing::{FrameReader, Oversized};
pub use identity::{
    device_key_from_peer_id, device_key_from_secret, pairing_fingerprint, peer_id_from_device_key,
};
pub use pairing::{
    PAIR_PROTOCOL, PAIRING_FRAME_MAX_BYTES, PairingError, PairingFrame, PairingOffer,
};
pub use status::{
    DeviceActionRecord, DeviceActionStatus, DeviceActionStatusError, decode_device_action_response,
    device_action_path,
};
pub use sync::{
    InboxRecord, MAX_SYNC_PAYLOAD_BYTES, OutboxRecord, OutboxStatus, SYNC_PROTOCOL, SyncCodecError,
    SyncErrorReason, SyncInboxItem, SyncReceipt, SyncRequest, SyncResponse,
    inbox_records_conflict, outbox_records_conflict,
};
