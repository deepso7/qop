//! `/qop/pair/1`: the `qop-pair1.` offer the desktop shows as a QR code and
//! the frames exchanged once the phone dials it (`pairing.ts`, `limits.ts`).
//! Both decoders are strict: unknown fields are rejected.

use alloy_primitives::{Address, B256, U256};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::Value;

use super::approval::DeviceActionApproval;
use super::json::{self, Obj, Parsed};

pub const PAIR_PROTOCOL: &str = "/qop/pair/1";
pub const PAIRING_QR_MAX_CHARS: usize = 1024;
pub const PAIRING_MAX_ADDRESSES: usize = 2;
pub const PAIRING_FRAME_MAX_BYTES: usize = 16 * 1024;
pub const PAIRING_TTL_SECONDS: u64 = 300;
pub const DEVICE_ACTION_DEADLINE_SECONDS: u64 = 600;
pub const MAX_ACTIVE_DEVICES: usize = 4;

const QR_PREFIX: &str = "qop-pair1.";
const MULTIADDR_MAX_CHARS: usize = 256;

/// The TS `PairingCodecError` operations.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PairingError {
    /// The offer's `expiresAt` is not after now.
    Expired,
    /// Not a valid pairing frame.
    Frame,
    /// Not a valid offer (bad base64, JSON or fields).
    Offer,
    /// Payload over `PAIRING_QR_MAX_CHARS` or frame over `PAIRING_FRAME_MAX_BYTES`.
    Oversized,
    /// Not a `qop-pair1.` payload.
    Version,
}

/// `PairingOfferV1`: everything the phone needs to dial and authenticate
/// this desktop. `addrs` holds 1-2 multiaddrs (relay first).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PairingOffer {
    pub addrs: Vec<String>,
    pub chain_id: U256,
    pub device_key: B256,
    pub expires_at: u64,
    pub qid: U256,
    pub registry: Address,
    pub secret: B256,
    pub session_id: B256,
}

impl PairingOffer {
    /// The `qop-pair1.<base64url JSON>` payload for the QR code and Copy button.
    pub fn encode(&self) -> Result<String, PairingError> {
        let value = self.to_json();
        // Encoding validates like the TS schema encode does.
        Self::from_json(&value).map_err(|_| PairingError::Offer)?;
        let payload = format!(
            "{QR_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(checked_size(&value)?)
        );

        if json::utf16_len(&payload) > PAIRING_QR_MAX_CHARS {
            return Err(PairingError::Oversized);
        }

        Ok(payload)
    }

    /// Decode a scanned or pasted payload; it must expire after `now_seconds`.
    pub fn decode(input: &str, now_seconds: u64) -> Result<Self, PairingError> {
        if json::utf16_len(input) > PAIRING_QR_MAX_CHARS {
            return Err(PairingError::Oversized);
        }

        let body = input.strip_prefix(QR_PREFIX).ok_or(PairingError::Version)?;
        let bytes = URL_SAFE_NO_PAD
            .decode(body)
            .map_err(|_| PairingError::Offer)?;
        let offer = json::parse(&bytes)
            .and_then(|value| Self::from_json(&value))
            .map_err(|_| PairingError::Offer)?;

        if offer.expires_at <= now_seconds {
            return Err(PairingError::Expired);
        }

        Ok(offer)
    }

    fn from_json(value: &Value) -> Parsed<Self> {
        let mut obj = Obj::new(value)?;
        let addrs = json::array(obj.field("addrs")?)?;

        if !(1..=PAIRING_MAX_ADDRESSES).contains(&addrs.len()) {
            return Err(json::Invalid);
        }

        let addrs = addrs.iter().map(multiaddr).collect::<Parsed<_>>()?;
        let offer = Self {
            addrs,
            chain_id: json::decimal_u256(obj.field("chainId")?, true)?,
            device_key: json::hex32(obj.field("deviceKey")?)?,
            expires_at: json::decimal_u64(obj.field("expiresAt")?)?,
            qid: json::decimal_u256(obj.field("qid")?, true)?,
            registry: json::address(obj.field("registry")?)?,
            secret: json::hex32(obj.field("secret")?)?,
            session_id: json::hex32(obj.field("sessionId")?)?,
        };
        json::version_1(obj.field("v")?)?;
        obj.finish(true)?;

        Ok(offer)
    }

    fn to_json(&self) -> Value {
        json::object([
            ("addrs", Value::from(self.addrs.clone())),
            ("chainId", json::decimal_value(&self.chain_id)),
            ("deviceKey", json::hex32_value(&self.device_key)),
            ("expiresAt", Value::String(self.expires_at.to_string())),
            ("qid", json::decimal_value(&self.qid)),
            ("registry", json::address_value(&self.registry)),
            ("secret", json::hex32_value(&self.secret)),
            ("sessionId", json::hex32_value(&self.session_id)),
            ("v", Value::from(1)),
        ])
    }
}

/// A multiaddr string as the offer schema checks it: 1-256 UTF-16 units, leading `/`.
fn multiaddr(value: &Value) -> Parsed<String> {
    let text = json::text(value, 1, MULTIADDR_MAX_CHARS)?;

    if text.starts_with('/') {
        Ok(text.to_owned())
    } else {
        Err(json::Invalid)
    }
}

/// JSON bytes of a pairing value, rejected over `PAIRING_FRAME_MAX_BYTES`.
fn checked_size(value: &Value) -> Result<Vec<u8>, PairingError> {
    let bytes = json::to_bytes(value);

    if bytes.len() > PAIRING_FRAME_MAX_BYTES {
        Err(PairingError::Oversized)
    } else {
        Ok(bytes)
    }
}

/// `PairingFrameV1`. The phone sends `Hello` then `Approval`; the desktop
/// answers `HelloAck`, then `ApprovalSaved` (persisted, or the same record
/// replayed) or `ApprovalConflict` (a different record is already pending).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PairingFrame {
    Hello {
        challenge: B256,
        secret: B256,
        session_id: B256,
    },
    HelloAck {
        chain_id: U256,
        challenge: B256,
        device_key: B256,
        qid: U256,
        registry: Address,
        session_id: B256,
    },
    Approval {
        record: DeviceActionApproval,
        session_id: B256,
    },
    ApprovalSaved {
        digest: B256,
        session_id: B256,
    },
    ApprovalConflict {
        digest: B256,
        session_id: B256,
    },
}

impl PairingFrame {
    /// Frame bytes; write them, then half-close the stream.
    pub fn encode(&self) -> Result<Vec<u8>, PairingError> {
        let value = self.to_json();
        Self::from_json(&value).map_err(|_| PairingError::Frame)?;

        checked_size(&value)
    }

    /// Decode the bytes read until the peer half-closed.
    pub fn decode(bytes: &[u8]) -> Result<Self, PairingError> {
        if bytes.len() > PAIRING_FRAME_MAX_BYTES {
            return Err(PairingError::Oversized);
        }

        json::parse(bytes)
            .and_then(|value| Self::from_json(&value))
            .map_err(|_| PairingError::Frame)
    }

    fn from_json(value: &Value) -> Parsed<Self> {
        let mut obj = Obj::new(value)?;
        let session_id = json::hex32(obj.field("sessionId")?)?;
        json::version_1(obj.field("v")?)?;

        let frame = match json::str(obj.field("type")?)? {
            "hello" => Self::Hello {
                challenge: json::hex32(obj.field("challenge")?)?,
                secret: json::hex32(obj.field("secret")?)?,
                session_id,
            },
            "helloAck" => Self::HelloAck {
                chain_id: json::decimal_u256(obj.field("chainId")?, true)?,
                challenge: json::hex32(obj.field("challenge")?)?,
                device_key: json::hex32(obj.field("deviceKey")?)?,
                qid: json::decimal_u256(obj.field("qid")?, true)?,
                registry: json::address(obj.field("registry")?)?,
                session_id,
            },
            "approval" => Self::Approval {
                record: DeviceActionApproval::from_json(obj.field("record")?)?,
                session_id,
            },
            "approvalSaved" => Self::ApprovalSaved {
                digest: json::hex32(obj.field("digest")?)?,
                session_id,
            },
            "approvalConflict" => Self::ApprovalConflict {
                digest: json::hex32(obj.field("digest")?)?,
                session_id,
            },
            _ => return Err(json::Invalid),
        };
        obj.finish(true)?;

        Ok(frame)
    }

    fn to_json(&self) -> Value {
        let v = || ("v", Value::from(1));
        let session = |id: &B256| ("sessionId", json::hex32_value(id));
        let kind = |name: &str| ("type", Value::from(name));

        match self {
            Self::Hello {
                challenge,
                secret,
                session_id,
            } => json::object([
                ("challenge", json::hex32_value(challenge)),
                ("secret", json::hex32_value(secret)),
                session(session_id),
                kind("hello"),
                v(),
            ]),
            Self::HelloAck {
                chain_id,
                challenge,
                device_key,
                qid,
                registry,
                session_id,
            } => json::object([
                ("chainId", json::decimal_value(chain_id)),
                ("challenge", json::hex32_value(challenge)),
                ("deviceKey", json::hex32_value(device_key)),
                ("qid", json::decimal_value(qid)),
                ("registry", json::address_value(registry)),
                session(session_id),
                kind("helloAck"),
                v(),
            ]),
            Self::Approval { record, session_id } => json::object([
                ("record", record.to_json()),
                session(session_id),
                kind("approval"),
                v(),
            ]),
            Self::ApprovalSaved { digest, session_id } => json::object([
                ("digest", json::hex32_value(digest)),
                session(session_id),
                kind("approvalSaved"),
                v(),
            ]),
            Self::ApprovalConflict { digest, session_id } => json::object([
                ("digest", json::hex32_value(digest)),
                session(session_id),
                kind("approvalConflict"),
                v(),
            ]),
        }
    }
}
