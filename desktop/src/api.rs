//! The device-action API, read-only: `GET {api}/v1/device-actions/{digest}`
//! (`cli/src/device-action-status.ts`). The phone submits; the desktop only watches.

use alloy_primitives::B256;

use crate::wire::{
    DeviceActionRecord, DeviceActionStatusError, decode_device_action_response, device_action_path,
};

/// Cheap to clone. Without a base URL every lookup is a network error, as in the CLI.
#[derive(Clone)]
pub struct ApiClient {
    base: Option<String>,
    agent: ureq::Agent,
}

impl ApiClient {
    pub fn new(base: Option<String>) -> ApiClient {
        ApiClient {
            base,
            agent: crate::rpc::agent(),
        }
    }

    /// Blocks; the engine calls it on tokio's blocking pool.
    pub fn device_action(
        &self,
        digest: &B256,
    ) -> Result<DeviceActionRecord, DeviceActionStatusError> {
        let base = self
            .base
            .as_deref()
            .ok_or(DeviceActionStatusError::Network)?;
        let mut response = self
            .agent
            .get(format!("{base}{}", device_action_path(digest)))
            .call()
            .map_err(|_| DeviceActionStatusError::Network)?;
        let status = response.status().as_u16();
        // An unreadable body on a 404 is still a 404; elsewhere it is undecodable.
        let body = response.body_mut().read_to_vec().unwrap_or_default();
        decode_device_action_response(status, &body)
    }
}
