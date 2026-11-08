//! `DeviceActionApprovalV1` (`approval.ts`): the owner-signed device action
//! the phone hands over during pairing and the desktop persists before
//! acknowledging it.

use alloy_primitives::{Address, B256};
use serde_json::Value;

use super::eip712::{DeviceIntent, EcdsaSignature, IdentityDomain};
use super::json::{self, Obj, Parsed};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalOperation {
    Add,
    Remove,
}

impl ApprovalOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Add => "add",
            Self::Remove => "remove",
        }
    }
}

/// One approval record. Add and remove records share every field but the
/// operation, so one struct models the TS union exactly.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceActionApproval {
    pub digest: B256,
    pub domain: IdentityDomain,
    pub expected_owner: Address,
    pub intent: DeviceIntent,
    pub operation: ApprovalOperation,
    pub owner_signature: EcdsaSignature,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalError {
    /// Not a valid `DeviceActionApprovalV1` JSON record.
    Decode,
    /// `digest` is not the EIP-712 digest of `domain` + `intent`.
    Digest,
}

impl DeviceActionApproval {
    /// Decode a record from JSON bytes (strict, as TS decodes stored records).
    pub fn decode(bytes: &[u8]) -> Result<Self, ApprovalError> {
        json::parse(bytes)
            .and_then(|value| Self::from_json(&value))
            .map_err(|_| ApprovalError::Decode)
    }

    /// Canonical JSON bytes; identical records encode identically, which is
    /// how replays are told from conflicts (`acknowledgeApproval`).
    pub fn encode(&self) -> Vec<u8> {
        json::to_bytes(&self.to_json())
    }

    /// Recompute the digest from domain and intent (`verifyApprovalDigest`).
    pub fn verify_digest(&self) -> Result<B256, ApprovalError> {
        let digest = match self.operation {
            ApprovalOperation::Add => self.intent.add_device_digest(&self.domain),
            ApprovalOperation::Remove => self.intent.remove_device_digest(&self.domain),
        }
        .map_err(|_| ApprovalError::Digest)?;

        if digest == self.digest {
            Ok(digest)
        } else {
            Err(ApprovalError::Digest)
        }
    }

    /// Always strict: TS decodes approvals with `strictParseOptions`.
    pub(crate) fn from_json(value: &Value) -> Parsed<Self> {
        let mut obj = Obj::new(value)?;
        let digest = json::hex32(obj.field("digest")?)?;
        let domain = IdentityDomain::from_json(obj.field("domain")?, true)?;
        let expected_owner = json::address(obj.field("expectedOwner")?)?;
        let intent = DeviceIntent::from_json(obj.field("intent")?, true)?;
        let operation = match json::str(obj.field("operation")?)? {
            "add" => ApprovalOperation::Add,
            "remove" => ApprovalOperation::Remove,
            _ => return Err(json::Invalid),
        };
        let owner_signature = EcdsaSignature::from_json(obj.field("ownerSignature")?)?;
        json::version_1(obj.field("v")?)?;
        obj.finish(true)?;

        Ok(Self {
            digest,
            domain,
            expected_owner,
            intent,
            operation,
            owner_signature,
        })
    }

    pub(crate) fn to_json(&self) -> Value {
        json::object([
            ("digest", json::hex32_value(&self.digest)),
            ("domain", self.domain.to_json()),
            ("expectedOwner", json::address_value(&self.expected_owner)),
            ("intent", self.intent.to_json()),
            ("operation", Value::from(self.operation.as_str())),
            (
                "ownerSignature",
                Value::String(self.owner_signature.to_hex()),
            ),
            ("v", Value::from(1)),
        ])
    }
}
