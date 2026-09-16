export type EnrollmentMembership =
  | "linked"
  | "pending"
  | "removed"
  | "wrong-account";

export type DeviceActionApiStatus =
  | "ready"
  | "submitted"
  | "confirmed"
  | "reverted"
  | "expired";

export type DeviceActionOperation = "add" | "remove";

/** Whether GET /device-actions/:digest observed a row. */
export type DeviceActionApiRecord = "present" | "missing" | "unknown";

/**
 * Contract `ExpiredIntent` is `block.timestamp > deadline`. Equality is still
 * executable — do not treat `chainTime === deadline` as expired.
 */
export const deviceActionDeadlineExpired = (
  deadline: bigint,
  chainTime: bigint
) => chainTime > deadline;

/** Linked/Removed is a current roster read, independent of digest confirmation. */
export const enrollmentMembership = ({
  activeQid,
  expectedQid,
  historicallyAdded,
}: {
  readonly activeQid: bigint | null;
  readonly expectedQid: bigint;
  readonly historicallyAdded: boolean;
}): EnrollmentMembership => {
  if (activeQid === expectedQid) {
    return "linked";
  }
  if (activeQid !== null && activeQid !== 0n) {
    return "wrong-account";
  }
  if (historicallyAdded) {
    return "removed";
  }
  return "pending";
};

export const isTerminalDeviceActionStatus = (
  status: DeviceActionApiStatus | null
) => status === "confirmed" || status === "reverted" || status === "expired";

/**
 * GET never stored this digest. Combined with a passed deadline, the intent
 * cannot execute — unlike ready/submitted, which keep occupying until a receipt.
 */
export const neverSubmittedDigestMissing = ({
  apiRecord,
  apiStatus,
}: {
  readonly apiRecord: DeviceActionApiRecord;
  readonly apiStatus: DeviceActionApiStatus | null;
}) => apiRecord === "missing" && apiStatus === null;

/** One in-flight digest per device; keep the slot until that digest cannot execute. */
export const occupiesApprovalSlot = ({
  apiRecord = "unknown",
  apiStatus,
  chainTime,
  deadline,
  membership,
  operation,
}: {
  readonly apiRecord?: DeviceActionApiRecord;
  readonly apiStatus: DeviceActionApiStatus | null;
  readonly chainTime?: bigint | undefined;
  readonly deadline?: bigint | undefined;
  readonly membership: EnrollmentMembership;
  readonly operation: DeviceActionOperation;
}) => {
  if (isTerminalDeviceActionStatus(apiStatus)) {
    return false;
  }
  // Never-submitted + GET 404/missing + chain time strictly after deadline:
  // cannot execute. ready/submitted keep occupying even if local clock is past.
  if (
    neverSubmittedDigestMissing({ apiRecord, apiStatus }) &&
    deadline !== undefined &&
    chainTime !== undefined &&
    deviceActionDeadlineExpired(deadline, chainTime)
  ) {
    return false;
  }
  // A submitted remove still occupies while the device remains active.
  if (operation === "remove") {
    return membership !== "removed";
  }
  return membership === "pending";
};

/**
 * Poll completion is operation-aware. Add finishes once linked (or a terminal
 * status that cannot become linked). Remove keeps going until the roster is
 * removed, or the digest is expired/reverted.
 */
export const enrollmentPollComplete = ({
  apiStatus,
  membership,
  operation,
}: {
  readonly apiStatus: DeviceActionApiStatus | null;
  readonly membership: EnrollmentMembership;
  readonly operation: DeviceActionOperation;
}) => {
  if (apiStatus === "expired" || apiStatus === "reverted") {
    return true;
  }
  if (operation === "remove") {
    return membership === "removed";
  }
  return (
    membership === "linked" ||
    membership === "removed" ||
    membership === "wrong-account"
  );
};
