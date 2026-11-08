//! EIP-712 device intents and owner signatures (`eip712.ts`,
//! `registry-intents.ts` and `EcdsaSignature` in `wire-codecs.ts`).
//!
//! The desktop never signs: it hashes the add-device intent the phone's owner
//! key signed and recovers the signer to compare with the account owner.

use alloy_primitives::{Address, B256, Signature, U256, hex, uint};
use alloy_sol_types::{Eip712Domain, SolStruct};
use serde_json::Value;

use super::json::{self, Obj, Parsed};

mod typed {
    alloy_sol_types::sol! {
        // Field order is part of the type hash; it matches
        // `addDeviceIntentEip712Types` / `removeDeviceIntentEip712Types`.
        struct AddDeviceV1 { uint256 qid; bytes32 deviceKey; uint256 nonce; uint64 deadline; }
        struct RemoveDeviceV1 { uint256 qid; bytes32 deviceKey; uint256 nonce; uint64 deadline; }
    }
}

/// Must match the immutable name and version of the deployed registry.
pub const IDENTITY_EIP712_DOMAIN_NAME: &str = "QOP Identity";
pub const IDENTITY_EIP712_DOMAIN_VERSION: &str = "1";

/// The registry's EIP-712 domain (`IdentityEip712DomainV1`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdentityDomain {
    pub chain_id: U256,
    pub verifying_contract: Address,
}

impl IdentityDomain {
    pub fn separator(&self) -> B256 {
        self.eip712().separator()
    }

    fn eip712(&self) -> Eip712Domain {
        Eip712Domain::new(
            Some(IDENTITY_EIP712_DOMAIN_NAME.into()),
            Some(IDENTITY_EIP712_DOMAIN_VERSION.into()),
            Some(self.chain_id),
            Some(self.verifying_contract),
            None,
        )
    }

    pub(crate) fn from_json(value: &Value, strict: bool) -> Parsed<Self> {
        let mut obj = Obj::new(value)?;
        let domain = Self {
            chain_id: json::decimal_u256(obj.field("chainId")?, true)?,
            verifying_contract: json::address(obj.field("verifyingContract")?)?,
        };
        obj.finish(strict)?;

        Ok(domain)
    }

    pub(crate) fn to_json(&self) -> Value {
        json::object([
            ("chainId", json::decimal_value(&self.chain_id)),
            (
                "verifyingContract",
                json::address_value(&self.verifying_contract),
            ),
        ])
    }
}

/// `AddDeviceIntentV1` / `RemoveDeviceIntentV1`: both have this shape.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceIntent {
    pub deadline: u64,
    pub device_key: B256,
    pub nonce: U256,
    pub qid: U256,
}

/// Why an intent could not be hashed or its signer recovered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntentError {
    /// A zero chain id, qid or device key (TS rejects these before hashing).
    InvalidInput,
    /// The signature is canonical but recovers no public key.
    Recovery,
}

impl DeviceIntent {
    /// The digest the owner signs for adding this device (`hashAddDeviceIntentV1`).
    pub fn add_device_digest(&self, domain: &IdentityDomain) -> Result<B256, IntentError> {
        self.validate(domain)?;

        Ok(typed::AddDeviceV1 {
            qid: self.qid,
            deviceKey: self.device_key,
            nonce: self.nonce,
            deadline: self.deadline,
        }
        .eip712_signing_hash(&domain.eip712()))
    }

    /// The digest for removing this device (`hashRemoveDeviceIntentV1`).
    pub fn remove_device_digest(&self, domain: &IdentityDomain) -> Result<B256, IntentError> {
        self.validate(domain)?;

        Ok(typed::RemoveDeviceV1 {
            qid: self.qid,
            deviceKey: self.device_key,
            nonce: self.nonce,
            deadline: self.deadline,
        }
        .eip712_signing_hash(&domain.eip712()))
    }

    /// The address that signed this add-device intent (`recoverAddDeviceIntentSignerV1`).
    pub fn recover_add_device_signer(
        &self,
        domain: &IdentityDomain,
        signature: &EcdsaSignature,
    ) -> Result<Address, IntentError> {
        let digest = self.add_device_digest(domain)?;

        signature
            .to_alloy()
            .recover_address_from_prehash(&digest)
            .map_err(|_| IntentError::Recovery)
    }

    fn validate(&self, domain: &IdentityDomain) -> Result<(), IntentError> {
        if domain.chain_id.is_zero() || self.qid.is_zero() || self.device_key.is_zero() {
            return Err(IntentError::InvalidInput);
        }

        Ok(())
    }

    pub(crate) fn from_json(value: &Value, strict: bool) -> Parsed<Self> {
        let mut obj = Obj::new(value)?;
        let intent = Self {
            deadline: json::decimal_u64(obj.field("deadline")?)?,
            device_key: json::non_zero_hex32(obj.field("deviceKey")?)?,
            nonce: json::decimal_u256(obj.field("nonce")?, false)?,
            qid: json::decimal_u256(obj.field("qid")?, true)?,
        };
        obj.finish(strict)?;

        Ok(intent)
    }

    pub(crate) fn to_json(&self) -> Value {
        json::object([
            ("deadline", Value::String(self.deadline.to_string())),
            ("deviceKey", json::hex32_value(&self.device_key)),
            ("nonce", json::decimal_value(&self.nonce)),
            ("qid", json::decimal_value(&self.qid)),
        ])
    }
}

/// secp256k1 group order n.
const SECP256K1_N: U256 =
    uint!(0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141_U256);

/// A canonical 65-byte `r || s || yParity` signature: 0 < r < n,
/// 0 < s <= n/2 (low s) and yParity 0 or 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EcdsaSignature([u8; 65]);

impl EcdsaSignature {
    /// Parse the lowercase `0x` hex form TS writes; `None` if not canonical.
    pub fn parse(text: &str) -> Option<Self> {
        let bytes: [u8; 65] = json::lower_hex(text, 130).ok()?.try_into().ok()?;
        let r = U256::from_be_slice(&bytes[..32]);
        let s = U256::from_be_slice(&bytes[32..64]);
        let canonical = bytes[64] <= 1
            && !r.is_zero()
            && r < SECP256K1_N
            && !s.is_zero()
            && s <= SECP256K1_N >> 1;

        canonical.then_some(Self(bytes))
    }

    pub fn to_hex(&self) -> String {
        hex::encode_prefixed(self.0)
    }

    fn to_alloy(self) -> Signature {
        Signature::new(
            U256::from_be_slice(&self.0[..32]),
            U256::from_be_slice(&self.0[32..64]),
            self.0[64] == 1,
        )
    }

    pub(crate) fn from_json(value: &Value) -> Parsed<Self> {
        Self::parse(json::str(value)?).ok_or(json::Invalid)
    }
}
