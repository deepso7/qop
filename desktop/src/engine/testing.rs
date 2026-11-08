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
    /// Other accounts (contacts), found by handle or device key.
    pub accounts: Vec<Account>,
    /// The head device-key lookups answer at; it advances on every lookup unless stuck.
    pub head: u64,
    pub stuck: bool,
    pub fail_lookups: bool,
    /// Keys that are nobody's device. Any other unknown key answers as `membership` says, since
    /// that is how tests stand in for the desktop's own (often fresh) key.
    pub strangers: Vec<B256>,
    hold: Option<Hold>,
}

/// An account at block 1 with these active devices.
pub fn account_with(qid: u64, handle: &str, devices: Vec<B256>) -> Account {
    Account {
        qid: U256::from(qid),
        owner: OWNER,
        nonce: U256::ZERO,
        handle: handle.into(),
        devices,
        block: 1,
    }
}

/// Holds the next device-key lookup until released, so a test can act mid-verification.
#[derive(Clone, Default)]
pub struct Hold {
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}

impl Hold {
    /// Resolves once the held lookup has started.
    pub async fn entered(&self) {
        self.entered.notified().await;
    }

    pub fn release(&self) {
        self.release.notify_one();
    }
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
            accounts: Vec::new(),
            head: 0,
            stuck: false,
            fail_lookups: false,
            strangers: Vec::new(),
            hold: None,
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

    pub fn add_account(&self, account: Account) {
        self.0.lock().unwrap().accounts.push(account);
    }

    /// A stuck head answers every lookup at the same block.
    pub fn stick_head(&self, stuck: bool) {
        self.0.lock().unwrap().stuck = stuck;
    }

    pub fn add_stranger(&self, device_key: B256) {
        self.0.lock().unwrap().strangers.push(device_key);
    }

    pub fn fail_lookups(&self, fail: bool) {
        self.0.lock().unwrap().fail_lookups = fail;
    }

    pub fn hold_lookups(&self) -> Hold {
        let hold = Hold::default();
        self.0.lock().unwrap().hold = Some(hold.clone());
        hold
    }
}

impl Chain for FakeChain {
    async fn lookup_handle(&self, handle: String) -> Result<Option<Account>, ReadError> {
        let state = self.0.lock().unwrap();
        if state.fail_lookups {
            return Err(ReadError::Rpc);
        }
        Ok(state
            .account
            .iter()
            .chain(&state.accounts)
            .find(|account| account.handle == handle)
            .cloned())
    }

    async fn lookup_device_key(&self, device_key: B256) -> Result<Option<Account>, ReadError> {
        let hold = self.0.lock().unwrap().hold.take();
        if let Some(hold) = hold {
            hold.entered.notify_one();
            hold.release.notified().await;
        }
        let mut state = self.0.lock().unwrap();
        if state.fail_lookups {
            return Err(ReadError::Rpc);
        }
        if !state.stuck {
            state.head += 1;
        }
        let head = state.head;
        let at_head = |account: &Account| Account {
            block: head,
            ..account.clone()
        };
        if let Some(account) = state
            .accounts
            .iter()
            .find(|a| a.devices.contains(&device_key))
        {
            return Ok(Some(at_head(account)));
        }
        if state.strangers.contains(&device_key) {
            return Ok(None);
        }
        match (state.membership, &state.account) {
            (Ok(Some(qid)), Some(account)) if account.qid == qid => {
                let mut account = at_head(account);
                account.devices.push(device_key);
                Ok(Some(account))
            }
            (Err(error), _) => Err(error),
            _ => Ok(None),
        }
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
