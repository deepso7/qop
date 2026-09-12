export type EnrollmentMembership =
  | "linked"
  | "pending"
  | "removed"
  | "wrong-account";

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
