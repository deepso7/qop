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

const terminalApiStatus = (status: DeviceActionApiStatus | null) =>
  status === "confirmed" || status === "reverted" || status === "expired";

/** One in-flight digest per device; release after terminal API or settled roster. */
export const occupiesApprovalSlot = ({
  apiStatus,
  membership,
}: {
  readonly apiStatus: DeviceActionApiStatus | null;
  readonly membership: EnrollmentMembership;
}) => {
  if (terminalApiStatus(apiStatus)) {
    return false;
  }
  return membership === "pending";
};
