import { describe, expect, it } from "vitest";

import { getAddingPhase } from "@/components/onboarding/adding-phase";
import type { LocalEnrollment } from "@/lib/local-enrollment";

const failed: LocalEnrollment = {
  deadline: "1700000600",
  digest: `0x${"ab".repeat(32)}`,
  failureCode: "EXPIRED",
  handle: "alice",
  nonce: "0",
  ownerAddress: `0x${"12".repeat(20)}`,
  qid: "1",
  status: "failed",
  version: 1,
};

describe("getAddingPhase", () => {
  it("explains a failed record by its reason", () => {
    expect(
      getAddingPhase({ busy: false, enrollment: failed, message: undefined })
    ).toEqual({
      final: false,
      kind: "failed",
      message: "The request expired before it went through. Try again.",
    });
  });

  // A retry that fails offline returns before writing a new record, so the
  // old failed record is still current.
  it("shows a failed retry's error over the old record's reason", () => {
    const message = "Couldn’t reach the registry. Check your connection.";

    expect(
      getAddingPhase({ busy: false, enrollment: failed, message })
    ).toMatchObject({ kind: "failed", message });
  });

  it("can't retry a removed phone", () => {
    expect(
      getAddingPhase({
        busy: false,
        enrollment: { ...failed, failureCode: "REMOVED" },
        message: undefined,
      })
    ).toMatchObject({ final: true, kind: "failed" });
  });
});
