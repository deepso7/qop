//! Strict `/qop/mailbox/1` JSON wire codecs (`packages/protocol/src/mailbox.ts`).

use alloy_primitives::{B256, hex};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::Value;

use super::chat::MAX_TIMESTAMP_MS;
use super::chat_envelope::MAX_CHAT_ENVELOPE_BYTES;
use super::json::{self, Obj, Parsed};

pub const MAILBOX_PROTOCOL: &str = "/qop/mailbox/1";
pub const MAX_MAILBOX_PAYLOAD_BYTES: usize = 128 * 1024;
pub const MAILBOX_MAX_DEPOSIT_ITEMS: usize = 4;
pub const MAILBOX_MAX_FETCH_LIMIT: usize = 16;
pub const MAILBOX_MAX_ACK_SEQS: usize = 16;

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MailboxDepositItem {
    pub envelope: String,
    pub id: String,
    pub recipient_device_key: B256,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MailboxMessage {
    pub envelope: String,
    pub id: String,
    pub sender_device_key: B256,
    pub seq: u64,
    pub stored_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MailboxRequest {
    Deposit { items: Vec<MailboxDepositItem> },
    Fetch { limit: u32 },
    Ack { seqs: Vec<u64> },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MailboxDepositedItem {
    pub id: String,
    pub recipient_device_key: B256,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MailboxResponse {
    Deposited {
        items: Vec<MailboxDepositedItem>,
    },
    Messages {
        has_more: bool,
        items: Vec<MailboxMessage>,
    },
    Acked {
        count: u64,
    },
    Error {
        reason: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MailboxCodecError {
    Oversized,
    Frame,
}

pub fn encode_base64(bytes: &[u8]) -> String {
    BASE64.encode(bytes)
}

pub fn decode_base64(encoded: &str) -> Result<Vec<u8>, MailboxCodecError> {
    if encoded.is_empty() {
        return Err(MailboxCodecError::Frame);
    }
    let bytes = BASE64
        .decode(encoded.as_bytes())
        .map_err(|_| MailboxCodecError::Frame)?;
    if bytes.is_empty() || bytes.len() > MAX_CHAT_ENVELOPE_BYTES {
        return Err(MailboxCodecError::Frame);
    }
    Ok(bytes)
}

impl MailboxRequest {
    pub fn encode(&self) -> Result<Vec<u8>, MailboxCodecError> {
        let value = match self {
            Self::Deposit { items } => {
                if items.is_empty() || items.len() > MAILBOX_MAX_DEPOSIT_ITEMS {
                    return Err(MailboxCodecError::Frame);
                }
                let mut encoded_items = Vec::with_capacity(items.len());
                for item in items {
                    if !json::is_uuid(&item.id) {
                        return Err(MailboxCodecError::Frame);
                    }
                    decode_base64(&item.envelope)?;
                    encoded_items.push(json::object([
                        ("envelope", Value::from(item.envelope.as_str())),
                        ("id", Value::from(item.id.as_str())),
                        (
                            "recipientDeviceKey",
                            Value::from(hex::encode_prefixed(item.recipient_device_key)),
                        ),
                    ]));
                }
                json::object([
                    ("items", Value::Array(encoded_items)),
                    ("type", Value::from("deposit")),
                    ("v", Value::from(1)),
                ])
            }
            Self::Fetch { limit } => {
                if *limit == 0 || *limit as usize > MAILBOX_MAX_FETCH_LIMIT {
                    return Err(MailboxCodecError::Frame);
                }
                json::object([
                    ("limit", Value::from(*limit)),
                    ("type", Value::from("fetch")),
                    ("v", Value::from(1)),
                ])
            }
            Self::Ack { seqs } => {
                if seqs.is_empty()
                    || seqs.len() > MAILBOX_MAX_ACK_SEQS
                    || seqs.iter().any(|&seq| seq == 0 || seq > MAX_SAFE_INTEGER)
                {
                    return Err(MailboxCodecError::Frame);
                }
                json::object([
                    (
                        "seqs",
                        Value::Array(seqs.iter().map(|&seq| Value::from(seq)).collect()),
                    ),
                    ("type", Value::from("ack")),
                    ("v", Value::from(1)),
                ])
            }
        };

        let bytes = json::to_bytes(&value);
        if bytes.len() > MAX_MAILBOX_PAYLOAD_BYTES {
            return Err(MailboxCodecError::Oversized);
        }
        Ok(bytes)
    }
}

fn read_message(value: &Value) -> Parsed<MailboxMessage> {
    let mut obj = Obj::new(value)?;
    let envelope = json::str(obj.field("envelope")?)?;
    decode_base64(envelope).map_err(|_| json::Invalid)?;
    let msg = MailboxMessage {
        envelope: envelope.to_owned(),
        id: json::uuid(obj.field("id")?)?.to_owned(),
        sender_device_key: json::hex32(obj.field("senderDeviceKey")?)?,
        seq: json::int(obj.field("seq")?, 1, MAX_SAFE_INTEGER)?,
        stored_at: json::int(obj.field("storedAt")?, 0, MAX_TIMESTAMP_MS)?,
    };
    obj.finish(true)?;
    Ok(msg)
}

impl MailboxResponse {
    pub fn decode(bytes: &[u8]) -> Result<Self, MailboxCodecError> {
        if bytes.len() > MAX_MAILBOX_PAYLOAD_BYTES {
            return Err(MailboxCodecError::Oversized);
        }
        let value = json::parse(bytes).map_err(|_| MailboxCodecError::Frame)?;
        Self::from_json(&value).map_err(|_| MailboxCodecError::Frame)
    }

    fn from_json(value: &Value) -> Parsed<Self> {
        let mut obj = Obj::new(value)?;
        json::version_1(obj.field("v")?)?;
        let response = match json::str(obj.field("type")?)? {
            "deposited" => {
                let raw_items = json::array(obj.field("items")?)?;
                if raw_items.is_empty() || raw_items.len() > MAILBOX_MAX_DEPOSIT_ITEMS {
                    return Err(json::Invalid);
                }
                let items = raw_items
                    .iter()
                    .map(|raw| {
                        let mut item_obj = Obj::new(raw)?;
                        let item = MailboxDepositedItem {
                            id: json::uuid(item_obj.field("id")?)?.to_owned(),
                            recipient_device_key: json::hex32(
                                item_obj.field("recipientDeviceKey")?,
                            )?,
                        };
                        item_obj.finish(true)?;
                        Ok(item)
                    })
                    .collect::<Parsed<Vec<_>>>()?;
                Self::Deposited { items }
            }
            "messages" => {
                let has_more = obj
                    .field("hasMore")?
                    .as_bool()
                    .ok_or(json::Invalid)?;
                let raw_items = json::array(obj.field("items")?)?;
                if raw_items.len() > MAILBOX_MAX_FETCH_LIMIT {
                    return Err(json::Invalid);
                }
                let items = raw_items
                    .iter()
                    .map(read_message)
                    .collect::<Parsed<Vec<_>>>()?;
                Self::Messages { has_more, items }
            }
            "acked" => Self::Acked {
                count: json::int(obj.field("count")?, 0, MAX_SAFE_INTEGER)?,
            },
            "error" => {
                let reason = json::str(obj.field("reason")?)?;
                if !matches!(reason, "invalid" | "quota" | "unauthorized" | "unavailable") {
                    return Err(json::Invalid);
                }
                Self::Error {
                    reason: reason.to_owned(),
                }
            }
            _ => return Err(json::Invalid),
        };
        obj.finish(true)?;
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_requests_and_strictly_decodes_responses() {
        let recipient = B256::repeat_byte(0xaa);
        let req = MailboxRequest::Deposit {
            items: vec![MailboxDepositItem {
                envelope: encode_base64(&[1, 2, 3]),
                id: "c56a4180-65aa-42ec-a945-5fd21dec0538".into(),
                recipient_device_key: recipient,
            }],
        };
        let encoded = req.encode().expect("encode");
        let parsed: Value = serde_json::from_slice(&encoded).expect("json");
        assert_eq!(parsed["type"], "deposit");
        assert_eq!(parsed["v"], 1);
        assert_eq!(
            decode_base64(parsed["items"][0]["envelope"].as_str().unwrap()).unwrap(),
            vec![1, 2, 3]
        );

        // Reject ack with > MAILBOX_MAX_ACK_SEQS or seq == 0.
        assert!(
            MailboxRequest::Ack {
                seqs: (1..=(MAILBOX_MAX_ACK_SEQS as u64 + 1)).collect(),
            }
            .encode()
            .is_err()
        );
        assert!(MailboxRequest::Ack { seqs: vec![0] }.encode().is_err());

        let valid = br#"{"hasMore":false,"items":[{"envelope":"AQID","id":"c56a4180-65aa-42ec-a945-5fd21dec0538","senderDeviceKey":"0x1111111111111111111111111111111111111111111111111111111111111111","seq":1,"storedAt":1700000000000}],"type":"messages","v":1}"#;
        let res = MailboxResponse::decode(valid).expect("decode");
        match res {
            MailboxResponse::Messages { has_more, items } => {
                assert!(!has_more);
                assert_eq!(items.len(), 1);
                assert_eq!(items[0].seq, 1);
            }
            other => panic!("unexpected {other:?}"),
        }

        // Strict rejections: seq == 0, unknown field, bad base64 padding, unknown error reason, oversized page.
        for bad in [
            br#"{"hasMore":false,"items":[{"envelope":"AQID","id":"c56a4180-65aa-42ec-a945-5fd21dec0538","senderDeviceKey":"0x1111111111111111111111111111111111111111111111111111111111111111","seq":0,"storedAt":1700000000000}],"type":"messages","v":1}"#.as_slice(),
            br#"{"count":1,"extra":true,"type":"acked","v":1}"#.as_slice(),
            br#"{"hasMore":false,"items":[{"envelope":"AB==","id":"c56a4180-65aa-42ec-a945-5fd21dec0538","senderDeviceKey":"0x1111111111111111111111111111111111111111111111111111111111111111","seq":1,"storedAt":1700000000000}],"type":"messages","v":1}"#.as_slice(),
            br#"{"reason":"conflict","type":"error","v":1}"#.as_slice(),
        ] {
            assert!(MailboxResponse::decode(bad).is_err());
        }

        let too_many: Vec<Value> = (1..=(MAILBOX_MAX_FETCH_LIMIT as u64 + 1))
            .map(|seq| {
                serde_json::json!({
                    "envelope": "AQID",
                    "id": "c56a4180-65aa-42ec-a945-5fd21dec0538",
                    "senderDeviceKey": format!("0x{}", "11".repeat(32)),
                    "seq": seq,
                    "storedAt": 1_700_000_000_000u64,
                })
            })
            .collect();
        let oversized_page = serde_json::to_vec(&serde_json::json!({
            "hasMore": false,
            "items": too_many,
            "type": "messages",
            "v": 1,
        }))
        .unwrap();
        assert!(MailboxResponse::decode(&oversized_page).is_err());
    }
}
