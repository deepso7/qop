//! Enrollment: after the phone approved, watch the API and the chain until this device's own
//! chain read shows it as an active member (`enrollment-poll.ts`, `pending-approval.ts`,
//! `membership.ts`).
//!
//! An [`Observation`] is gathered off the engine (network IO), then [`decide`] turns it into the
//! next step, purely, in the order of the plan's pending-approval transition table:
//!
//! | Observation | [`Next`] |
//! | --- | --- |
//! | Own key is an active member of the account | `Link` |
//! | Own key not active, registry marks it removed | `Rotate` (a removed key can never return) |
//! | API status `expired` or `reverted` | `Release` the approval, keep the key |
//! | API has no record and chain time is strictly after the deadline | `Release` |
//! | Anything else | `Wait` |
//!
//! "Anything else" includes `ready`, `submitted`, `confirmed` not yet visible to our own read, an
//! unreachable API or RPC, and a passed deadline the API still has a record for. The same rule
//! decides whether a stored approval still occupies the slot when a pairing frame arrives.

use alloy_primitives::{B256, U256};

use super::{Api, Chain};
use crate::model::EnrollmentProgress;
use crate::rpc::ReadError;
use crate::wire::{DeviceActionApproval, DeviceActionStatus, DeviceActionStatusError};

/// What `GET /v1/device-actions/:digest` said (`DeviceActionApiLookup`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApiLookup {
    Present(DeviceActionStatus),
    /// 404: the API never stored this digest.
    Missing,
    /// No usable answer (network, server error, undecodable), or nothing was asked.
    Unknown,
}

impl From<Result<DeviceActionStatus, DeviceActionStatusError>> for ApiLookup {
    fn from(result: Result<DeviceActionStatus, DeviceActionStatusError>) -> Self {
        match result {
            Ok(status) => Self::Present(status),
            Err(DeviceActionStatusError::Missing) => Self::Missing,
            Err(_) => Self::Unknown,
        }
    }
}

/// Whether a pending add approval still holds this device's one approval slot: it is released
/// only when it can no longer execute. Unlike `occupiesApprovalSlot`, `confirmed` keeps it until
/// our own chain read agrees (the plan's table), since the API can lead our RPC's head.
pub fn approval_occupies(api: ApiLookup, chain_time: Option<u64>, deadline: u64) -> bool {
    match api {
        ApiLookup::Present(DeviceActionStatus::Expired | DeviceActionStatus::Reverted) => false,
        // `chainTime == deadline` is still executable (`deviceActionDeadlineExpired`).
        ApiLookup::Missing => !chain_time.is_some_and(|time| time > deadline),
        _ => true,
    }
}

/// One poll's worth of facts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Observation {
    /// The API's view of the pending approval; `Unknown` when there is none.
    pub api: ApiLookup,
    /// Latest chain time; read only while an approval is pending.
    pub chain_time: Option<u64>,
    /// The account the own key is an active member of.
    pub membership: Result<Option<U256>, ReadError>,
    /// The registry's removal marker; read only when the key is not active in the account.
    pub removed: Option<bool>,
}

/// What to do after an observation while pairing or awaiting enrollment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Next {
    Link,
    /// Generate a fresh device key, drop the approval, pair again.
    Rotate,
    /// Drop the approval, keep the key, pair again.
    Release,
    Wait(EnrollmentProgress),
}

/// The transition table above. `deadline` is the pending approval's, if there is one.
pub fn decide(expected_qid: U256, deadline: Option<u64>, observation: &Observation) -> Next {
    match observation.membership {
        Ok(Some(qid)) if qid == expected_qid => return Next::Link,
        Ok(None) if observation.removed == Some(true) => return Next::Rotate,
        // Unknown membership might be Linked: never release on it.
        Err(_) => return Next::Wait(progress(observation.api)),
        _ => {}
    }
    match deadline {
        Some(deadline) if !approval_occupies(observation.api, observation.chain_time, deadline) => {
            Next::Release
        }
        _ => Next::Wait(progress(observation.api)),
    }
}

fn progress(api: ApiLookup) -> EnrollmentProgress {
    match api {
        ApiLookup::Present(DeviceActionStatus::Submitted) => EnrollmentProgress::Submitted,
        ApiLookup::Present(DeviceActionStatus::Confirmed) => EnrollmentProgress::Confirming,
        _ => EnrollmentProgress::Approved,
    }
}

/// Reads everything [`decide`] needs. The removal marker is read only when the key is not an
/// active member of `expected_qid` (`readEnrollmentState`).
pub async fn observe(
    chain: &impl Chain,
    api: &impl Api,
    device_key: B256,
    expected_qid: U256,
    approval: Option<&DeviceActionApproval>,
) -> Observation {
    let (api, chain_time) = match approval {
        Some(approval) => (
            api.device_action(approval.digest).await.into(),
            chain.latest_timestamp().await.ok(),
        ),
        None => (ApiLookup::Unknown, None),
    };
    let membership = chain.membership(device_key).await;
    let removed = match membership {
        Ok(qid) if qid != Some(expected_qid) => chain.key_removed(device_key).await.ok(),
        _ => None,
    };
    Observation {
        api,
        chain_time,
        membership,
        removed,
    }
}

/// The stored approval if it still occupies the slot; otherwise it is cleared and `None` is
/// returned (`loadOccupyingApproval`). Read before acknowledging a new approval frame.
pub async fn load_occupying<E>(
    load: impl FnOnce() -> Result<Option<DeviceActionApproval>, E>,
    clear: impl FnOnce() -> Result<(), E>,
    chain: &impl Chain,
    api: &impl Api,
) -> Result<Option<DeviceActionApproval>, E> {
    let Some(pending) = load()? else {
        return Ok(None);
    };
    let status = api.device_action(pending.digest).await.into();
    let chain_time = chain.latest_timestamp().await.ok();
    if approval_occupies(status, chain_time, pending.intent.deadline) {
        Ok(Some(pending))
    } else {
        clear()?;
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::testing::{FakeApi, FakeChain, approval};

    const QID: u64 = 42;
    const DEADLINE: u64 = 1_700_003_600;

    fn qid() -> U256 {
        U256::from(QID)
    }

    fn observed(
        api: ApiLookup,
        chain_time: Option<u64>,
        membership: Option<u64>,
        removed: Option<bool>,
    ) -> Observation {
        Observation {
            api,
            chain_time,
            membership: Ok(membership.map(U256::from)),
            removed,
        }
    }

    // The pending-approval transition table, row by row.

    #[test]
    fn row_1_active_member_links_whatever_the_api_says() {
        for api in [
            ApiLookup::Unknown,
            ApiLookup::Present(DeviceActionStatus::Expired),
            ApiLookup::Missing,
        ] {
            assert_eq!(
                decide(
                    qid(),
                    Some(DEADLINE),
                    &observed(api, Some(DEADLINE + 1), Some(QID), None)
                ),
                Next::Link
            );
        }
    }

    #[test]
    fn row_2_added_then_removed_rotates_before_any_api_status() {
        let removed = observed(
            ApiLookup::Present(DeviceActionStatus::Confirmed),
            None,
            None,
            Some(true),
        );
        assert_eq!(decide(qid(), Some(DEADLINE), &removed), Next::Rotate);
        assert_eq!(decide(qid(), None, &removed), Next::Rotate);
    }

    #[test]
    fn row_3_expired_or_reverted_releases_the_approval() {
        for status in [DeviceActionStatus::Expired, DeviceActionStatus::Reverted] {
            let o = observed(
                ApiLookup::Present(status),
                Some(DEADLINE - 100),
                None,
                Some(false),
            );
            assert_eq!(decide(qid(), Some(DEADLINE), &o), Next::Release);
        }
    }

    #[test]
    fn row_4_missing_releases_only_strictly_after_the_deadline() {
        let at = |time| {
            decide(
                qid(),
                Some(DEADLINE),
                &observed(ApiLookup::Missing, Some(time), None, Some(false)),
            )
        };
        assert_eq!(at(DEADLINE), Next::Wait(EnrollmentProgress::Approved));
        assert_eq!(at(DEADLINE + 1), Next::Release);
        // Unknown chain time never releases.
        let o = observed(ApiLookup::Missing, None, None, Some(false));
        assert_eq!(
            decide(qid(), Some(DEADLINE), &o),
            Next::Wait(EnrollmentProgress::Approved)
        );
    }

    #[test]
    fn row_5_everything_else_waits_with_progress() {
        let after = Some(DEADLINE + 1);
        let cases = [
            (
                ApiLookup::Present(DeviceActionStatus::Ready),
                EnrollmentProgress::Approved,
            ),
            (
                ApiLookup::Present(DeviceActionStatus::Submitted),
                EnrollmentProgress::Submitted,
            ),
            // Confirmed by the API but not yet by our own read: never treated as removed.
            (
                ApiLookup::Present(DeviceActionStatus::Confirmed),
                EnrollmentProgress::Confirming,
            ),
            (ApiLookup::Unknown, EnrollmentProgress::Approved),
        ];
        for (api, progress) in cases {
            assert_eq!(
                decide(
                    qid(),
                    Some(DEADLINE),
                    &observed(api, after, None, Some(false))
                ),
                Next::Wait(progress)
            );
        }
        // RPC down: even an expired status waits, since we might already be linked.
        let rpc_down = Observation {
            api: ApiLookup::Present(DeviceActionStatus::Expired),
            chain_time: None,
            membership: Err(ReadError::Rpc),
            removed: None,
        };
        assert_eq!(
            decide(qid(), Some(DEADLINE), &rpc_down),
            Next::Wait(EnrollmentProgress::Approved)
        );
        // A failed removal-marker read is not removal.
        assert_eq!(
            decide(qid(), None, &observed(ApiLookup::Unknown, None, None, None)),
            Next::Wait(EnrollmentProgress::Approved)
        );
        // Active in another account: not ours, not removed.
        assert_eq!(
            decide(
                qid(),
                None,
                &observed(ApiLookup::Unknown, None, Some(7), Some(true))
            ),
            Next::Wait(EnrollmentProgress::Approved)
        );
    }

    // Ports of `cli/test/enrollment-poll.test.ts`, polling through `observe`.

    #[tokio::test]
    async fn keeps_polling_after_api_confirmed_until_the_roster_agrees() {
        let chain = FakeChain::default();
        let api = FakeApi::status(DeviceActionStatus::Confirmed);
        let pending = approval(9, DEADLINE);
        let key = pending.intent.device_key;

        let first = observe(&chain, &api, key, qid(), Some(&pending)).await;
        assert_eq!(
            decide(qid(), Some(DEADLINE), &first),
            Next::Wait(EnrollmentProgress::Confirming)
        );

        chain.set_membership(Some(QID));
        let second = observe(&chain, &api, key, qid(), Some(&pending)).await;
        assert_eq!(decide(qid(), Some(DEADLINE), &second), Next::Link);
    }

    #[tokio::test]
    async fn treats_the_registry_removal_marker_as_added_then_removed_after_restart() {
        let chain = FakeChain::default();
        chain.set_removed(Ok(true));
        let api = FakeApi::status(DeviceActionStatus::Confirmed);
        let pending = approval(9, DEADLINE);

        let o = observe(
            &chain,
            &api,
            pending.intent.device_key,
            qid(),
            Some(&pending),
        )
        .await;
        assert_eq!(o.removed, Some(true));
        assert_eq!(decide(qid(), Some(DEADLINE), &o), Next::Rotate);
    }

    #[tokio::test]
    async fn keeps_pending_when_the_removal_marker_read_fails() {
        let chain = FakeChain::default();
        chain.set_removed(Err(ReadError::Rpc));
        let o = observe(
            &chain,
            &FakeApi::status(DeviceActionStatus::Confirmed),
            B256::repeat_byte(9),
            qid(),
            None,
        )
        .await;
        assert_eq!(
            decide(qid(), None, &o),
            Next::Wait(EnrollmentProgress::Approved)
        );
    }

    #[tokio::test]
    async fn links_from_a_live_roster_without_an_approval() {
        let chain = FakeChain::default();
        chain.set_membership(Some(QID));
        let o = observe(&chain, &FakeApi::down(), B256::repeat_byte(9), qid(), None).await;
        assert_eq!((o.removed, decide(qid(), None, &o)), (None, Next::Link));
    }

    #[tokio::test]
    async fn waits_while_status_requests_keep_failing() {
        let chain = FakeChain::default();
        let pending = approval(9, DEADLINE);
        for _ in 0..3 {
            let o = observe(
                &chain,
                &FakeApi::down(),
                pending.intent.device_key,
                qid(),
                Some(&pending),
            )
            .await;
            assert_eq!(o.api, ApiLookup::Unknown);
            assert_eq!(
                decide(qid(), Some(DEADLINE), &o),
                Next::Wait(EnrollmentProgress::Approved)
            );
        }
    }

    // Ports of `cli/test/pending-approval.test.ts`.

    async fn occupying(api: FakeApi, chain_time: u64) -> (Option<B256>, bool) {
        let chain = FakeChain::default();
        chain.set_time(chain_time);
        let stored = std::cell::RefCell::new(Some(approval(9, DEADLINE)));
        let kept = load_occupying::<()>(
            || Ok(stored.borrow().clone()),
            || {
                *stored.borrow_mut() = None;
                Ok(())
            },
            &chain,
            &api,
        )
        .await
        .unwrap();
        let still_stored = stored.borrow().is_some();
        (kept.map(|a| a.digest), still_stored)
    }

    #[tokio::test]
    async fn keeps_a_never_submitted_digest_when_get_is_404_at_the_deadline() {
        let (kept, stored) = occupying(FakeApi::missing(), DEADLINE).await;
        assert!(kept.is_some() && stored);
    }

    #[tokio::test]
    async fn clears_a_never_submitted_digest_when_get_is_404_after_the_deadline() {
        assert_eq!(
            occupying(FakeApi::missing(), DEADLINE + 1).await,
            (None, false)
        );
    }

    #[tokio::test]
    async fn keeps_a_submitted_digest_after_the_deadline() {
        let (kept, stored) =
            occupying(FakeApi::status(DeviceActionStatus::Submitted), DEADLINE + 1).await;
        assert!(kept.is_some() && stored);
    }

    #[tokio::test]
    async fn keeps_a_digest_when_get_fails_as_a_network_error() {
        let (kept, stored) = occupying(FakeApi::down(), DEADLINE).await;
        assert!(kept.is_some() && stored);
    }
}
