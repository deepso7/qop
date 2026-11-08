//! `GET {api}/v1/device-actions/{digest}` (`cli/src/device-action-status.ts`):
//! the API's view of a submitted approval. The response decoder ignores
//! unknown fields.

use alloy_primitives::B256;
use serde_json::Value;

use super::json::{self, Obj, Parsed};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeviceActionStatus {
    Ready,
    Submitted,
    Confirmed,
    Reverted,
    Expired,
}

/// One device-action row as the API reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceActionRecord {
    pub digest: B256,
    pub failure_code: Option<String>,
    pub status: DeviceActionStatus,
    pub transaction_hash: Option<B256>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeviceActionStatusError {
    /// The body is not a valid record (also: unparseable JSON on any status).
    Decode,
    /// 404: the API has no record of this digest.
    Missing,
    /// Another non-2xx status, or no response at all.
    Network,
}

/// The request path for `digest`, relative to the API base URL.
pub fn device_action_path(digest: &B256) -> String {
    format!(
        "/v1/device-actions/{}",
        alloy_primitives::hex::encode_prefixed(digest)
    )
}

/// Interpret an HTTP response in the same order as the CLI: 404 first, then
/// the JSON body (read for every other status), then the status code.
pub fn decode_device_action_response(
    status: u16,
    body: &[u8],
) -> Result<DeviceActionRecord, DeviceActionStatusError> {
    if status == 404 {
        return Err(DeviceActionStatusError::Missing);
    }

    let value = json::parse_lossy(body).map_err(|_| DeviceActionStatusError::Decode)?;

    if !(200..=299).contains(&status) {
        return Err(DeviceActionStatusError::Network);
    }

    record_from_json(&value).map_err(|_| DeviceActionStatusError::Decode)
}

fn record_from_json(value: &Value) -> Parsed<DeviceActionRecord> {
    let mut obj = Obj::new(value)?;

    Ok(DeviceActionRecord {
        digest: json::hex32(obj.field("digest")?)?,
        failure_code: json::null_or(obj.field("failureCode")?, |code| {
            json::str(code).map(str::to_owned)
        })?,
        status: match json::str(obj.field("status")?)? {
            "ready" => DeviceActionStatus::Ready,
            "submitted" => DeviceActionStatus::Submitted,
            "confirmed" => DeviceActionStatus::Confirmed,
            "reverted" => DeviceActionStatus::Reverted,
            "expired" => DeviceActionStatus::Expired,
            _ => return Err(json::Invalid),
        },
        transaction_hash: json::null_or(obj.field("transactionHash")?, json::hex32)?,
    })
}
