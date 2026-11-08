//! `/qop/sync/1` between a phone and its own linked devices (`sync.ts`,
//! `outbox.ts`). The phone sends one request; the device answers with one
//! response. Both decoders are strict, including the nested records and
//! chat frames.

use alloy_primitives::B256;
use serde_json::Value;

use super::chat::{ChatFrame, MAX_TIMESTAMP_MS};
use super::json::{self, Obj, Parsed};

pub const SYNC_PROTOCOL: &str = "/qop/sync/1";
/// One inbox record can wrap a max chat frame, so the cap is above 16 KB.
pub const MAX_SYNC_PAYLOAD_BYTES: usize = 64 * 1024;
pub const SYNC_POLL_MAX_IDS: usize = 32;

const MAX_ATTEMPTS: u64 = 1_000_000;
const MAX_ERROR_NOTE_UNITS: usize = 400;
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncCodecError {
    Frame,
    Oversized,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutboxStatus {
    Queued,
    Sent,
    Failed,
}

impl OutboxStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Sent => "sent",
            Self::Failed => "failed",
        }
    }

    pub fn parse(status: &str) -> Option<Self> {
        match status {
            "queued" => Some(Self::Queued),
            "sent" => Some(Self::Sent),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

/// `OutboxRecordV1`. Qids are kept as the canonical decimal strings TS
/// uses (`OutboxQid` has no upper bound, so they need not fit a U256).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutboxRecord {
    pub attempts: u64,
    pub frame: ChatFrame,
    pub last_error: Option<String>,
    pub next_attempt_at: u64,
    pub queued_at: u64,
    pub status: OutboxStatus,
    pub to_handle: String,
    pub to_qid: String,
    pub updated_at: u64,
}

impl OutboxRecord {
    fn from_json(value: &Value) -> Parsed<Self> {
        let mut obj = Obj::new(value)?;
        let record = Self {
            attempts: json::int(obj.field("attempts")?, 0, MAX_ATTEMPTS)?,
            frame: ChatFrame::from_json(obj.field("frame")?, true)?,
            last_error: json::null_or(obj.field("lastError")?, |note| {
                json::text(note, 1, MAX_ERROR_NOTE_UNITS).map(str::to_owned)
            })?,
            next_attempt_at: timestamp(obj.field("nextAttemptAt")?)?,
            queued_at: timestamp(obj.field("queuedAt")?)?,
            status: OutboxStatus::parse(json::str(obj.field("status")?)?).ok_or(json::Invalid)?,
            to_handle: json::handle(obj.field("toHandle")?)?.to_owned(),
            to_qid: qid(obj.field("toQid")?)?,
            updated_at: timestamp(obj.field("updatedAt")?)?,
        };
        json::version_1(obj.field("v")?)?;
        obj.finish(true)?;

        Ok(record)
    }

    fn to_json(&self) -> Value {
        json::object([
            ("attempts", Value::from(self.attempts)),
            ("frame", self.frame.to_json()),
            (
                "lastError",
                self.last_error.as_deref().map_or(Value::Null, Value::from),
            ),
            ("nextAttemptAt", Value::from(self.next_attempt_at)),
            ("queuedAt", Value::from(self.queued_at)),
            ("status", Value::from(self.status.as_str())),
            ("toHandle", Value::from(self.to_handle.as_str())),
            ("toQid", Value::from(self.to_qid.as_str())),
            ("updatedAt", Value::from(self.updated_at)),
            ("v", Value::from(1)),
        ])
    }
}

/// `InboxRecordV1`: a message this device received from `from_qid`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InboxRecord {
    pub frame: ChatFrame,
    pub from_qid: String,
    pub received_at: u64,
}

impl InboxRecord {
    fn from_json(value: &Value) -> Parsed<Self> {
        let mut obj = Obj::new(value)?;
        let record = Self {
            frame: ChatFrame::from_json(obj.field("frame")?, true)?,
            from_qid: qid(obj.field("fromQid")?)?,
            received_at: timestamp(obj.field("receivedAt")?)?,
        };
        json::version_1(obj.field("v")?)?;
        obj.finish(true)?;

        Ok(record)
    }

    fn to_json(&self) -> Value {
        json::object([
            ("frame", self.frame.to_json()),
            ("fromQid", Value::from(self.from_qid.as_str())),
            ("receivedAt", Value::from(self.received_at)),
            ("v", Value::from(1)),
        ])
    }
}

/// `outboxRecordsConflict`: the same message id must keep the same content (recipient, sender,
/// time, text); status and retry bookkeeping may change.
pub fn outbox_records_conflict(existing: &OutboxRecord, candidate: &OutboxRecord) -> bool {
    existing.frame.id == candidate.frame.id
        && (existing.to_handle != candidate.to_handle
            || existing.to_qid != candidate.to_qid
            || existing.frame.from_handle != candidate.frame.from_handle
            || existing.frame.sent_at != candidate.frame.sent_at
            || existing.frame.text != candidate.frame.text)
}

/// `inboxRecordsConflict`: the same sender and id must keep the same content; the same id from
/// a different sender is a different message.
pub fn inbox_records_conflict(existing: &InboxRecord, candidate: &InboxRecord) -> bool {
    existing.frame.id == candidate.frame.id
        && existing.from_qid == candidate.from_qid
        && (existing.frame.from_handle != candidate.frame.from_handle
            || existing.frame.sent_at != candidate.frame.sent_at
            || existing.frame.text != candidate.frame.text)
}

/// Phone → device.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SyncRequest {
    /// Deliver this queued message for the phone; answer `Held` once persisted.
    Handoff {
        composed_by: B256,
        record: OutboxRecord,
    },
    /// Which of these (1-32) handed-off ids has the device delivered?
    Poll { ids: Vec<String> },
    /// Inbox records after this cursor (the holder's inbox seq).
    Catchup { after: u64 },
}

impl SyncRequest {
    pub fn encode(&self) -> Result<Vec<u8>, SyncCodecError> {
        encode(&self.to_json(), |value| Self::from_json(value).map(drop))
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, SyncCodecError> {
        decode(bytes, Self::from_json)
    }

    fn from_json(value: &Value) -> Parsed<Self> {
        let mut obj = Obj::new(value)?;
        json::version_1(obj.field("v")?)?;

        let request = match json::str(obj.field("type")?)? {
            "handoff" => {
                let composed_by = json::hex32(obj.field("composedBy")?)?;
                let record = OutboxRecord::from_json(obj.field("record")?)?;

                if record.status != OutboxStatus::Queued {
                    return Err(json::Invalid);
                }

                Self::Handoff {
                    composed_by,
                    record,
                }
            }
            "poll" => {
                let ids = json::array(obj.field("ids")?)?;

                if !(1..=SYNC_POLL_MAX_IDS).contains(&ids.len()) {
                    return Err(json::Invalid);
                }

                Self::Poll {
                    ids: ids
                        .iter()
                        .map(|id| json::uuid(id).map(str::to_owned))
                        .collect::<Parsed<_>>()?,
                }
            }
            "catchup" => Self::Catchup {
                after: json::int(obj.field("after")?, 0, MAX_SAFE_INTEGER)?,
            },
            _ => return Err(json::Invalid),
        };
        obj.finish(true)?;

        Ok(request)
    }

    fn to_json(&self) -> Value {
        match self {
            Self::Handoff {
                composed_by,
                record,
            } => json::object([
                ("composedBy", json::hex32_value(composed_by)),
                ("record", record.to_json()),
                ("type", Value::from("handoff")),
                ("v", Value::from(1)),
            ]),
            Self::Poll { ids } => json::object([
                ("ids", Value::from(ids.clone())),
                ("type", Value::from("poll")),
                ("v", Value::from(1)),
            ]),
            Self::Catchup { after } => json::object([
                ("after", Value::from(*after)),
                ("type", Value::from("catchup")),
                ("v", Value::from(1)),
            ]),
        }
    }
}

/// A handed-off message the device delivered (`SyncReceiptV1`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncReceipt {
    pub delivered_at: u64,
    pub id: String,
    pub to_qid: String,
}

/// One inbox record and its position in the holder's inbox (`SyncInboxItemV1`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncInboxItem {
    pub record: InboxRecord,
    pub seq: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncErrorReason {
    Conflict,
    Invalid,
    /// The device could not persist the handoff; it holds nothing.
    Unavailable,
}

/// Device → phone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SyncResponse {
    Held {
        id: String,
    },
    /// At most 32 receipts.
    Receipts {
        receipts: Vec<SyncReceipt>,
    },
    /// `last_seq` is the highest inbox seq held; `after > last_seq` tells the
    /// phone this device's store was reset.
    Inbox {
        last_seq: u64,
        records: Vec<SyncInboxItem>,
    },
    Error {
        reason: SyncErrorReason,
    },
}

impl SyncResponse {
    pub fn encode(&self) -> Result<Vec<u8>, SyncCodecError> {
        encode(&self.to_json(), |value| Self::from_json(value).map(drop))
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, SyncCodecError> {
        decode(bytes, Self::from_json)
    }

    fn from_json(value: &Value) -> Parsed<Self> {
        let mut obj = Obj::new(value)?;
        json::version_1(obj.field("v")?)?;

        let response = match json::str(obj.field("type")?)? {
            "held" => Self::Held {
                id: json::uuid(obj.field("id")?)?.to_owned(),
            },
            "receipts" => {
                let receipts = json::array(obj.field("receipts")?)?;

                if receipts.len() > SYNC_POLL_MAX_IDS {
                    return Err(json::Invalid);
                }

                Self::Receipts {
                    receipts: receipts
                        .iter()
                        .map(receipt_from_json)
                        .collect::<Parsed<_>>()?,
                }
            }
            "inbox" => Self::Inbox {
                last_seq: json::int(obj.field("lastSeq")?, 0, MAX_SAFE_INTEGER)?,
                records: json::array(obj.field("records")?)?
                    .iter()
                    .map(inbox_item_from_json)
                    .collect::<Parsed<_>>()?,
            },
            "error" => Self::Error {
                reason: match json::str(obj.field("reason")?)? {
                    "conflict" => SyncErrorReason::Conflict,
                    "invalid" => SyncErrorReason::Invalid,
                    "unavailable" => SyncErrorReason::Unavailable,
                    _ => return Err(json::Invalid),
                },
            },
            _ => return Err(json::Invalid),
        };
        obj.finish(true)?;

        Ok(response)
    }

    fn to_json(&self) -> Value {
        let tail = |kind: &str| [("type", Value::from(kind)), ("v", Value::from(1))];

        match self {
            Self::Held { id } => {
                let [kind, v] = tail("held");
                json::object([("id", Value::from(id.as_str())), kind, v])
            }
            Self::Receipts { receipts } => {
                let [kind, v] = tail("receipts");
                let receipts = receipts
                    .iter()
                    .map(|receipt| {
                        json::object([
                            ("deliveredAt", Value::from(receipt.delivered_at)),
                            ("id", Value::from(receipt.id.as_str())),
                            ("toQid", Value::from(receipt.to_qid.as_str())),
                        ])
                    })
                    .collect();
                json::object([("receipts", Value::Array(receipts)), kind, v])
            }
            Self::Inbox { last_seq, records } => {
                let [kind, v] = tail("inbox");
                let records = records
                    .iter()
                    .map(|item| {
                        json::object([
                            ("record", item.record.to_json()),
                            ("seq", Value::from(item.seq)),
                        ])
                    })
                    .collect();
                json::object([
                    ("lastSeq", Value::from(*last_seq)),
                    ("records", Value::Array(records)),
                    kind,
                    v,
                ])
            }
            Self::Error { reason } => {
                let [kind, v] = tail("error");
                let reason = match reason {
                    SyncErrorReason::Conflict => "conflict",
                    SyncErrorReason::Invalid => "invalid",
                    SyncErrorReason::Unavailable => "unavailable",
                };
                json::object([("reason", Value::from(reason)), kind, v])
            }
        }
    }
}

fn receipt_from_json(value: &Value) -> Parsed<SyncReceipt> {
    let mut obj = Obj::new(value)?;
    let receipt = SyncReceipt {
        delivered_at: timestamp(obj.field("deliveredAt")?)?,
        id: json::uuid(obj.field("id")?)?.to_owned(),
        to_qid: qid(obj.field("toQid")?)?,
    };
    obj.finish(true)?;

    Ok(receipt)
}

fn inbox_item_from_json(value: &Value) -> Parsed<SyncInboxItem> {
    let mut obj = Obj::new(value)?;
    let item = SyncInboxItem {
        record: InboxRecord::from_json(obj.field("record")?)?,
        seq: json::int(obj.field("seq")?, 1, MAX_SAFE_INTEGER)?,
    };
    obj.finish(true)?;

    Ok(item)
}

fn timestamp(value: &Value) -> Parsed<u64> {
    json::int(value, 0, MAX_TIMESTAMP_MS)
}

/// `OutboxQid`: `^[1-9][0-9]*$`, at most 78 digits.
fn qid(value: &Value) -> Parsed<String> {
    let text = json::str(value)?;
    let canonical = (1..=78).contains(&text.len())
        && !text.starts_with('0')
        && text.bytes().all(|byte| byte.is_ascii_digit());

    if canonical {
        Ok(text.to_owned())
    } else {
        Err(json::Invalid)
    }
}

fn encode(
    value: &Value,
    validate: impl FnOnce(&Value) -> Parsed<()>,
) -> Result<Vec<u8>, SyncCodecError> {
    validate(value).map_err(|_| SyncCodecError::Frame)?;
    let bytes = json::to_bytes(value);

    if bytes.len() > MAX_SYNC_PAYLOAD_BYTES {
        Err(SyncCodecError::Oversized)
    } else {
        Ok(bytes)
    }
}

fn decode<T>(bytes: &[u8], read: impl FnOnce(&Value) -> Parsed<T>) -> Result<T, SyncCodecError> {
    if bytes.len() > MAX_SYNC_PAYLOAD_BYTES {
        return Err(SyncCodecError::Oversized);
    }

    json::parse(bytes)
        .and_then(|value| read(&value))
        .map_err(|_| SyncCodecError::Frame)
}
