//! The registry reads a linked device makes (`registry-reader.ts`): calldata
//! builders, handle hashing, and decoders for the raw `eth_call` results.
//! Head capture, pinning and the RPC client itself live with the engine.
//!
//! The decoders reproduce viem's `decodeFunctionResult` followed by the
//! reader's schema checks, including viem's leniency: trailing bytes and the
//! high 12 bytes of an address word are ignored, integers are read as a full
//! word and range-checked afterwards. They also keep the TS error split:
//! [`RegistryError::Abi`] where viem throws (TS reports `rpc`),
//! [`RegistryError::Decode`] where the reader's schemas reject.

use alloy_primitives::{Address, B256, U256, keccak256};
use alloy_sol_types::SolCall;
use minip2p::PeerId;

use crate::wire::{identity, json};

mod calls {
    // Only the call side is generated; return data is decoded by hand below.
    alloy_sol_types::sol! {
        function account(uint256 qid);
        function listActiveDevices(uint256 qid);
        function qidByHandleHash(bytes32 handleHash);
        function qidByDeviceKey(bytes32 deviceKey);
        function deviceKeyRemoved(bytes32 deviceKey);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegistryError {
    /// Not a valid handle (`lookupHandle` fails with `invalid-handle`).
    InvalidHandle,
    /// The return data is not ABI-decodable.
    Abi,
    /// ABI-decodable, but the values fail the reader's checks.
    Decode,
}

/// An active device of an account.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegistryDevice {
    pub device_key: B256,
    pub peer_id: PeerId,
}

/// The registry's `account(qid)` tuple.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountRecord {
    pub owner: Address,
    pub owner_version: u32,
    pub registered_at: u64,
    pub nonce: U256,
    pub handle: String,
}

/// `keccak256(handle)` for a valid handle, the key of `qidByHandleHash`.
pub fn handle_hash(handle: &str) -> Result<B256, RegistryError> {
    if json::is_handle(handle) {
        Ok(keccak256(handle))
    } else {
        Err(RegistryError::InvalidHandle)
    }
}

pub fn qid_by_handle_hash_call(handle: &str) -> Result<Vec<u8>, RegistryError> {
    Ok(calls::qidByHandleHashCall {
        handleHash: handle_hash(handle)?,
    }
    .abi_encode())
}

pub fn qid_by_device_key_call(device_key: &B256) -> Vec<u8> {
    calls::qidByDeviceKeyCall {
        deviceKey: *device_key,
    }
    .abi_encode()
}

pub fn account_call(qid: U256) -> Vec<u8> {
    calls::accountCall { qid }.abi_encode()
}

pub fn list_active_devices_call(qid: U256) -> Vec<u8> {
    calls::listActiveDevicesCall { qid }.abi_encode()
}

pub fn device_key_removed_call(device_key: &B256) -> Vec<u8> {
    calls::deviceKeyRemovedCall {
        deviceKey: *device_key,
    }
    .abi_encode()
}

/// `qidByHandleHash` / `qidByDeviceKey`: `None` when the registry returns 0.
pub fn decode_qid(data: &[u8]) -> Result<Option<U256>, RegistryError> {
    let qid = Abi::new(data)?.uint(0)?;

    Ok((!qid.is_zero()).then_some(qid))
}

/// `deviceKeyRemoved`: whether the key was ever removed from any account.
pub fn decode_bool(data: &[u8]) -> Result<bool, RegistryError> {
    let word = Abi::new(data)?.word(0)?;

    // viem: every byte but the last is zero, and the last is 0 or 1.
    match (word[..31].iter().all(|&byte| byte == 0), word[31]) {
        (true, 0) => Ok(false),
        (true, 1) => Ok(true),
        _ => Err(RegistryError::Abi),
    }
}

/// `listActiveDevices`: the active device keys with their peer IDs.
pub fn decode_active_devices(data: &[u8]) -> Result<Vec<RegistryDevice>, RegistryError> {
    let abi = Abi::new(data)?;
    let start = abi.offset(0)?;
    let length = abi.offset(start)?;
    // Collect every word before validating, as viem decodes fully first.
    let keys = (0..length)
        .map(|index| abi.word(start + 32 + 32 * index).map(B256::from))
        .collect::<Result<Vec<_>, _>>()?;

    keys.into_iter()
        .map(|device_key| {
            if device_key.is_zero() {
                return Err(RegistryError::Decode);
            }

            Ok(RegistryDevice {
                peer_id: identity::peer_id_from_device_key(&device_key),
                device_key,
            })
        })
        .collect()
}

/// `account(qid)`. The tuple has a dynamic member, so it sits behind an offset.
pub fn decode_account(data: &[u8]) -> Result<AccountRecord, RegistryError> {
    let abi = Abi::new(data)?;
    let start = abi.offset(0)?;
    let owner = Address::from_slice(&abi.word(start)?[12..]);
    // viem reads uint32 as a JS number: above 2^53 it throws while decoding.
    let owner_version = abi.uint(start + 32)?;

    if owner_version > U256::from(MAX_SAFE_INTEGER) {
        return Err(RegistryError::Abi);
    }

    let registered_at = abi.uint(start + 64)?;
    let nonce = abi.uint(start + 96)?;
    let handle_start = start + abi.offset(start + 128)?;
    let handle_length = abi.offset(handle_start)?;
    let handle = match handle_length {
        0 => String::new(),
        length => String::from_utf8_lossy(abi.bytes(handle_start + 32, length)?).into_owned(),
    };

    Ok(AccountRecord {
        owner,
        owner_version: owner_version
            .try_into()
            .map_err(|_| RegistryError::Decode)?,
        registered_at: registered_at
            .try_into()
            .map_err(|_| RegistryError::Decode)?,
        nonce,
        handle: if json::is_handle(&handle) {
            handle
        } else {
            return Err(RegistryError::Decode);
        },
    })
}

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// Bounds-checked reads over ABI return data, mirroring viem's cursor.
struct Abi<'a>(&'a [u8]);

impl<'a> Abi<'a> {
    fn new(data: &'a [u8]) -> Result<Self, RegistryError> {
        if data.len() < 32 {
            Err(RegistryError::Abi)
        } else {
            Ok(Self(data))
        }
    }

    fn bytes(&self, at: usize, length: usize) -> Result<&'a [u8], RegistryError> {
        let end = at.checked_add(length).ok_or(RegistryError::Abi)?;

        self.0.get(at..end).ok_or(RegistryError::Abi)
    }

    fn word(&self, at: usize) -> Result<[u8; 32], RegistryError> {
        Ok(self.bytes(at, 32)?.try_into().expect("32-byte slice"))
    }

    fn uint(&self, at: usize) -> Result<U256, RegistryError> {
        Ok(U256::from_be_bytes(self.word(at)?))
    }

    /// An offset or length word: viem requires a JS safe integer.
    fn offset(&self, at: usize) -> Result<usize, RegistryError> {
        let value = self.uint(at)?;

        if value > U256::from(MAX_SAFE_INTEGER) {
            return Err(RegistryError::Abi);
        }

        value.try_into().map_err(|_| RegistryError::Abi)
    }
}
