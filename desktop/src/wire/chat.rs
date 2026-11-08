//! `/qop/chat/1` frames and ACKs (`chat-wire.ts`). Unlike pairing and sync,
//! these decoders ignore unknown fields so newer senders stay readable.

use serde_json::Value;

use super::json::{self, Obj, Parsed};

pub const CHAT_PROTOCOL: &str = "/qop/chat/1";
pub const MAX_CHAT_PAYLOAD_BYTES: usize = 16 * 1024;

const MAX_TEXT_UNITS: usize = 4000;
/// Largest JS `Date` value, in milliseconds.
pub(crate) const MAX_TIMESTAMP_MS: u64 = 8_640_000_000_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatError {
    /// Not a valid frame or ACK.
    Invalid,
    /// Over `MAX_CHAT_PAYLOAD_BYTES`.
    Oversized,
}

/// `ChatFrameV1`: one message. `id` is a UUID (any case), `sent_at` is Unix
/// milliseconds, `text` is 1-4000 UTF-16 code units.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatFrame {
    pub from_handle: String,
    pub id: String,
    pub sent_at: u64,
    pub text: String,
}

impl ChatFrame {
    pub fn encode(&self) -> Result<Vec<u8>, ChatError> {
        encode(&self.to_json(), |value| {
            Self::from_json(value, false).map(drop)
        })
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ChatError> {
        decode(bytes, |value| Self::from_json(value, false))
    }

    /// Lenient in chat; strict when nested in sync records.
    pub(crate) fn from_json(value: &Value, strict: bool) -> Parsed<Self> {
        let mut obj = Obj::new(value)?;
        let frame = Self {
            from_handle: json::handle(obj.field("fromHandle")?)?.to_owned(),
            id: json::uuid(obj.field("id")?)?.to_owned(),
            sent_at: json::int(obj.field("sentAt")?, 0, MAX_TIMESTAMP_MS)?,
            text: json::text(obj.field("text")?, 1, MAX_TEXT_UNITS)?.to_owned(),
        };
        json::version_1(obj.field("v")?)?;
        obj.finish(strict)?;

        Ok(frame)
    }

    pub(crate) fn to_json(&self) -> Value {
        json::object([
            ("fromHandle", Value::from(self.from_handle.as_str())),
            ("id", Value::from(self.id.as_str())),
            ("sentAt", Value::from(self.sent_at)),
            ("text", Value::from(self.text.as_str())),
            ("v", Value::from(1)),
        ])
    }
}

/// `ChatAckV1`: the recipient saved message `ack`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatAck {
    pub ack: String,
}

impl ChatAck {
    pub fn encode(&self) -> Result<Vec<u8>, ChatError> {
        encode(&self.to_json(), |value| Self::from_json(value).map(drop))
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ChatError> {
        decode(bytes, Self::from_json)
    }

    fn from_json(value: &Value) -> Parsed<Self> {
        let mut obj = Obj::new(value)?;
        let ack = json::uuid(obj.field("ack")?)?.to_owned();
        json::version_1(obj.field("v")?)?;

        Ok(Self { ack })
    }

    fn to_json(&self) -> Value {
        json::object([
            ("ack", Value::from(self.ack.as_str())),
            ("v", Value::from(1)),
        ])
    }
}

/// Validate as TS does before encoding, then enforce the size cap.
fn encode(
    value: &Value,
    validate: impl FnOnce(&Value) -> Parsed<()>,
) -> Result<Vec<u8>, ChatError> {
    validate(value).map_err(|_| ChatError::Invalid)?;
    let bytes = json::to_bytes(value);

    if bytes.len() > MAX_CHAT_PAYLOAD_BYTES {
        Err(ChatError::Oversized)
    } else {
        Ok(bytes)
    }
}

fn decode<T>(bytes: &[u8], read: impl FnOnce(&Value) -> Parsed<T>) -> Result<T, ChatError> {
    if bytes.len() > MAX_CHAT_PAYLOAD_BYTES {
        return Err(ChatError::Oversized);
    }

    json::parse(bytes)
        .and_then(|value| read(&value))
        .map_err(|_| ChatError::Invalid)
}
