//! Fakes for the engine's ports and signed fixtures, shared by the engine's unit tests.

use std::sync::{Arc, Mutex};

use alloy_primitives::{Address, B256, U256, address, hex};

use super::{Api, Chain};
use crate::rpc::{Account, ReadError};
use crate::wire::{
    ApprovalOperation, DeviceActionApproval, DeviceActionStatus, DeviceActionStatusError,
    DeviceIntent, EcdsaSignature, IdentityDomain,
};

pub const QID: u64 = 42;
pub const CHAIN_ID: u64 = 31337;
pub const REGISTRY: Address = address!("1111111111111111111111111111111111111111");
/// The address of secp256k1 secret key 1, the owner in every fixture.
pub const OWNER: Address = address!("7e5f4552091a69125d5dfcb7b8c2659029395bdf");
/// The desktop's device key in every fixture.
pub const DEVICE_KEY: B256 = B256::repeat_byte(9);
/// The approving phone's device key.
pub const PHONE_KEY: B256 = B256::repeat_byte(0x22);

pub fn domain() -> IdentityDomain {
    IdentityDomain {
        chain_id: U256::from(CHAIN_ID),
        verifying_contract: REGISTRY,
    }
}

/// An add-device approval for [`DEVICE_KEY`] signed by secret key `signer`.
pub fn signed_approval(nonce: u64, deadline: u64, signer: u8) -> DeviceActionApproval {
    approval_for(DEVICE_KEY, nonce, deadline, signer)
}

/// An add-device approval for `device_key` signed by secret key `signer`.
pub fn approval_for(
    device_key: B256,
    nonce: u64,
    deadline: u64,
    signer: u8,
) -> DeviceActionApproval {
    let intent = DeviceIntent {
        deadline,
        device_key,
        nonce: U256::from(nonce),
        qid: U256::from(QID),
    };
    let digest = intent.add_device_digest(&domain()).expect("valid intent");
    let mut secret = [0; 32];
    secret[31] = signer;
    let key = k256::ecdsa::SigningKey::from_slice(&secret).expect("valid secret");
    // k256 signs low-s, with the recovery id to match.
    let (signature, recovery) = key
        .sign_prehash_recoverable(digest.as_slice())
        .expect("signs");
    let bytes = [&signature.to_bytes()[..], &[recovery.to_byte()]].concat();
    DeviceActionApproval {
        digest,
        domain: domain(),
        expected_owner: OWNER,
        intent,
        operation: ApprovalOperation::Add,
        owner_signature: EcdsaSignature::parse(&hex::encode_prefixed(bytes))
            .expect("canonical signature"),
    }
}

/// An approval signed by the owner.
pub fn approval(nonce: u64, deadline: u64) -> DeviceActionApproval {
    signed_approval(nonce, deadline, 1)
}

/// A scripted chain; clones share state.
#[derive(Clone)]
pub struct FakeChain(Arc<Mutex<ChainState>>);

pub struct ChainState {
    pub membership: Result<Option<U256>, ReadError>,
    pub removed: Result<bool, ReadError>,
    pub time: Result<u64, ReadError>,
    pub account: Option<Account>,
}

impl Default for FakeChain {
    fn default() -> Self {
        FakeChain(Arc::new(Mutex::new(ChainState {
            membership: Ok(None),
            removed: Ok(false),
            time: Ok(1_700_003_000),
            account: Some(Account {
                qid: U256::from(QID),
                owner: OWNER,
                nonce: U256::from(9),
                handle: "alice".into(),
                devices: vec![PHONE_KEY],
                block: 1,
            }),
        })))
    }
}

impl FakeChain {
    pub fn set_membership(&self, qid: Option<u64>) {
        self.0.lock().unwrap().membership = Ok(qid.map(U256::from));
    }

    pub fn set_removed(&self, removed: Result<bool, ReadError>) {
        self.0.lock().unwrap().removed = removed;
    }

    pub fn set_devices(&self, devices: Vec<B256>) {
        if let Some(account) = &mut self.0.lock().unwrap().account {
            account.devices = devices;
        }
    }

    pub fn set_time(&self, time: u64) {
        self.0.lock().unwrap().time = Ok(time);
    }
}

impl Chain for FakeChain {
    async fn lookup_handle(&self, handle: String) -> Result<Option<Account>, ReadError> {
        let account = self.0.lock().unwrap().account.clone();
        Ok(account.filter(|account| account.handle == handle))
    }

    async fn account_with_time(&self, qid: U256) -> Result<Option<(Account, u64)>, ReadError> {
        let state = self.0.lock().unwrap();
        let time = state.time?;
        Ok(state
            .account
            .clone()
            .filter(|account| account.qid == qid)
            .map(|account| (account, time)))
    }

    async fn membership(&self, _: B256) -> Result<Option<U256>, ReadError> {
        self.0.lock().unwrap().membership
    }

    async fn key_removed(&self, _: B256) -> Result<bool, ReadError> {
        self.0.lock().unwrap().removed
    }

    async fn latest_timestamp(&self) -> Result<u64, ReadError> {
        self.0.lock().unwrap().time
    }
}

/// A scripted API; clones share state.
#[derive(Clone)]
pub struct FakeApi(Arc<Mutex<Result<DeviceActionStatus, DeviceActionStatusError>>>);

impl FakeApi {
    fn answering(answer: Result<DeviceActionStatus, DeviceActionStatusError>) -> FakeApi {
        FakeApi(Arc::new(Mutex::new(answer)))
    }

    pub fn status(status: DeviceActionStatus) -> FakeApi {
        Self::answering(Ok(status))
    }

    pub fn missing() -> FakeApi {
        Self::answering(Err(DeviceActionStatusError::Missing))
    }

    pub fn down() -> FakeApi {
        Self::answering(Err(DeviceActionStatusError::Network))
    }

    pub fn set(&self, answer: Result<DeviceActionStatus, DeviceActionStatusError>) {
        *self.0.lock().unwrap() = answer;
    }
}

impl Api for FakeApi {
    async fn device_action(&self, _: B256) -> Result<DeviceActionStatus, DeviceActionStatusError> {
        *self.0.lock().unwrap()
    }
}
