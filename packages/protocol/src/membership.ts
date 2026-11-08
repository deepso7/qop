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

/**
 * What GET /device-actions/:digest observed: a row with its status, a
 * confirmed absence (404), or nothing usable (network/server error).
 */
export type DeviceActionApiLookup =
  | { readonly kind: "present"; readonly status: DeviceActionApiStatus }
  | { readonly kind: "missing" }
  | { readonly kind: "unknown" };

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

export const isTerminalDeviceActionStatus = (status: DeviceActionApiStatus) =>
  status === "confirmed" || status === "reverted" || status === "expired";

/** One in-flight digest per device; keep the slot until that digest cannot execute. */
export const occupiesApprovalSlot = ({
  api,
  chainTime,
  deadline,
  membership,
  operation,
}: {
  readonly api: DeviceActionApiLookup;
  readonly chainTime?: bigint | undefined;
  readonly deadline?: bigint | undefined;
  readonly membership: EnrollmentMembership;
  readonly operation: DeviceActionOperation;
}) => {
  if (api.kind === "present" && isTerminalDeviceActionStatus(api.status)) {
    return false;
  }

  // GET never stored this digest + chain time strictly after deadline: it
  // cannot execute. ready/submitted keep occupying even if local clock is past.
  if (
    api.kind === "missing" &&
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
