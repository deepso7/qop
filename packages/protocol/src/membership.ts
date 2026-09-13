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

/** One in-flight digest per device; keep the slot until that digest cannot execute. */
export const occupiesApprovalSlot = ({
  apiStatus,
  membership,
  operation,
}: {
  readonly apiStatus: DeviceActionApiStatus | null;
  readonly membership: EnrollmentMembership;
  readonly operation: DeviceActionOperation;
}) => {
  if (isTerminalDeviceActionStatus(apiStatus)) {
    return false;
  }
  // A submitted remove still occupies while the device remains active.
  if (operation === "remove") {
    return membership !== "removed";
  }
  return membership === "pending";
};
