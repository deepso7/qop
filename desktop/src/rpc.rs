//! Read-only chain access: a lean JSON-RPC client (`eth_blockNumber`, `eth_getBlockByNumber`,
//! `eth_call`) and the registry reads on top of it (`registry-reader.ts`).
//!
//! Every lookup first captures the head (TS `freshness: "fresh"` always holds here) (`eth_blockNumber`) and pins all of its calls to that
//! block, so one answer never mixes two chain states (`registry-reader.ts` `captureHead`).
//! Calls block; the engine runs them on tokio's blocking pool.

use std::time::Duration;

use alloy_primitives::{Address, B256, U256, hex};
use serde_json::{Value, json};

use crate::registry::{self, RegistryError};

/// One HTTP request, connect to last byte.
const TIMEOUT: Duration = Duration::from_secs(10);

/// Why a read failed: as `RegistryReaderError` in TS.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadError {
    InvalidHandle,
    /// Transport, JSON-RPC error, or undecodable ABI (viem throws, TS reports `rpc`).
    Rpc,
    /// Decodable, but fails the reader's checks.
    Decode,
}

impl From<RegistryError> for ReadError {
    fn from(error: RegistryError) -> Self {
        match error {
            RegistryError::InvalidHandle => Self::InvalidHandle,
            RegistryError::Abi => Self::Rpc,
            RegistryError::Decode => Self::Decode,
        }
    }
}

/// An account as of one block.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Account {
    pub qid: U256,
    pub owner: Address,
    pub nonce: U256,
    pub handle: String,
    pub devices: Vec<B256>,
    pub block: u64,
}

pub(crate) fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .http_status_as_error(false)
        .build()
        .into()
}

/// The registry reader over one JSON-RPC endpoint. Cheap to clone.
#[derive(Clone)]
pub struct RegistryReader {
    url: String,
    registry: Address,
    agent: ureq::Agent,
}

impl RegistryReader {
    pub fn new(url: &str, registry: Address) -> RegistryReader {
        RegistryReader {
            url: url.to_owned(),
            registry,
            agent: agent(),
        }
    }

    fn request(&self, method: &str, params: Value) -> Result<Value, ReadError> {
        let body =
            json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }).to_string();
        let mut response = self
            .agent
            .post(&self.url)
            .header("content-type", "application/json")
            .send(body)
            .map_err(|_| ReadError::Rpc)?;
        let bytes = response
            .body_mut()
            .read_to_vec()
            .map_err(|_| ReadError::Rpc)?;
        let mut value: Value = serde_json::from_slice(&bytes).map_err(|_| ReadError::Rpc)?;
        match value.get_mut("result") {
            Some(result) if !result.is_null() => Ok(result.take()),
            _ => Err(ReadError::Rpc),
        }
    }

    /// The latest block number: the head the next reads pin to.
    pub fn head(&self) -> Result<u64, ReadError> {
        quantity(&self.request("eth_blockNumber", json!([]))?)
    }

    fn timestamp_at(&self, block: u64) -> Result<u64, ReadError> {
        let block = self.request(
            "eth_getBlockByNumber",
            json!([format!("{block:#x}"), false]),
        )?;
        quantity(block.get("timestamp").ok_or(ReadError::Rpc)?)
    }

    fn call(&self, data: &[u8], block: u64) -> Result<Vec<u8>, ReadError> {
        let call = json!({ "to": self.registry.to_string(), "data": hex::encode_prefixed(data) });
        let result = self.request("eth_call", json!([call, format!("{block:#x}")]))?;
        hex::decode(result.as_str().ok_or(ReadError::Rpc)?).map_err(|_| ReadError::Rpc)
    }

    fn account_at(&self, qid: U256, block: u64) -> Result<Account, ReadError> {
        let record = registry::decode_account(&self.call(&registry::account_call(qid), block)?)?;
        let devices = registry::decode_active_devices(
            &self.call(&registry::list_active_devices_call(qid), block)?,
        )?;
        Ok(Account {
            qid,
            owner: record.owner,
            nonce: record.nonce,
            handle: record.handle,
            devices: devices
                .into_iter()
                .map(|device| device.device_key)
                .collect(),
            block,
        })
    }

    /// The account registered under `handle`, if any (`lookupHandle`).
    pub fn lookup_handle(&self, handle: &str) -> Result<Option<Account>, ReadError> {
        let data = registry::qid_by_handle_hash_call(handle)?;
        let block = self.head()?;
        match registry::decode_qid(&self.call(&data, block)?)? {
            Some(qid) => self.account_at(qid, block).map(Some),
            None => Ok(None),
        }
    }

    /// The account `qid` and the chain time, both at one head: what pairing checks against.
    pub fn account_with_time(&self, qid: U256) -> Result<(Account, u64), ReadError> {
        let block = self.head()?;
        Ok((self.account_at(qid, block)?, self.timestamp_at(block)?))
    }

    /// The account `device_key` is an active member of, if any (`lookupDeviceKey`). A stale
    /// `qidByDeviceKey` hit whose roster lacks the key is no membership.
    pub fn membership(&self, device_key: &B256) -> Result<Option<U256>, ReadError> {
        let block = self.head()?;
        let Some(qid) = registry::decode_qid(
            &self.call(&registry::qid_by_device_key_call(device_key), block)?,
        )?
        else {
            return Ok(None);
        };
        let devices = registry::decode_active_devices(
            &self.call(&registry::list_active_devices_call(qid), block)?,
        )?;
        Ok(devices
            .iter()
            .any(|device| &device.device_key == device_key)
            .then_some(qid))
    }

    /// The account `device_key` is an active member of, read at one head (`lookupDeviceKey`):
    /// what live authorization checks a peer against. `block` is that head, so callers can
    /// demand a strictly newer one than their last confirmation. A stale `qidByDeviceKey` hit
    /// whose roster lacks the key is `None`.
    pub fn lookup_device_key(&self, device_key: &B256) -> Result<Option<Account>, ReadError> {
        let block = self.head()?;
        let Some(qid) = registry::decode_qid(
            &self.call(&registry::qid_by_device_key_call(device_key), block)?,
        )?
        else {
            return Ok(None);
        };
        let account = self.account_at(qid, block)?;
        Ok(account.devices.contains(device_key).then_some(account))
    }

    /// The registry's permanent marker: this key was added and later removed (or wiped).
    pub fn key_removed(&self, device_key: &B256) -> Result<bool, ReadError> {
        let block = self.head()?;
        Ok(registry::decode_bool(&self.call(
            &registry::device_key_removed_call(device_key),
            block,
        )?)?)
    }

    /// The timestamp of the current head (`latestTimestamp`).
    pub fn latest_timestamp(&self) -> Result<u64, ReadError> {
        self.timestamp_at(self.head()?)
    }
}

/// A JSON-RPC quantity (`"0x1a"`).
fn quantity(value: &Value) -> Result<u64, ReadError> {
    let digits = value
        .as_str()
        .and_then(|s| s.strip_prefix("0x"))
        .ok_or(ReadError::Rpc)?;
    u64::from_str_radix(digits, 16).map_err(|_| ReadError::Rpc)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_quantities_and_rejects_anything_else() {
        assert_eq!(quantity(&json!("0x1a")), Ok(26));
        assert_eq!(quantity(&json!(26)), Err(ReadError::Rpc));
        assert_eq!(quantity(&json!("1a")), Err(ReadError::Rpc));
    }

    #[test]
    fn an_unreachable_endpoint_is_an_rpc_error() {
        let reader = RegistryReader::new("http://127.0.0.1:9", Address::ZERO);
        assert_eq!(reader.head(), Err(ReadError::Rpc));
        assert_eq!(
            reader.lookup_handle("Not A Handle"),
            Err(ReadError::InvalidHandle)
        );
    }
}
