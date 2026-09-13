import { describe, expect, it } from "vitest";

import { createLifecycleAdapter } from "../src/lifecycle.ts";
import {
  deviceActionDeadlineExpired,
  enrollmentMembership,
  enrollmentPollComplete,
  occupiesApprovalSlot,
} from "../src/membership.ts";

describe("lifecycle adapter", () => {
  it("invalidates when wall time advances across a monotonic pause", () => {
    let monotonic = 0;
    let wall = 0;
    const adapter = createLifecycleAdapter({
      monotonicNow: () => monotonic,
      stallThresholdMs: 1000,
      wallNow: () => wall,
    });

    expect(adapter.takeInvalidation()).toBe(false);
    wall += 60_000;
    monotonic += 10;
    expect(adapter.takeInvalidation()).toBe(true);
    expect(adapter.takeInvalidation()).toBe(false);
  });

  it("invalidates when the event loop stalls on the monotonic clock", () => {
    let monotonic = 0;
    let wall = 0;
    const adapter = createLifecycleAdapter({
      monotonicNow: () => monotonic,
      stallThresholdMs: 1000,
      wallNow: () => wall,
    });

    monotonic += 5000;
    wall += 5000;
    expect(adapter.takeInvalidation()).toBe(true);
  });

  it("invalidates on an explicit resume even when clocks did not jump", () => {
    const monotonic = 0;
    const wall = 0;
    const adapter = createLifecycleAdapter({
      monotonicNow: () => monotonic,
      stallThresholdMs: 1000,
      wallNow: () => wall,
    });

    expect(adapter.takeInvalidation()).toBe(false);
    adapter.markInterrupted();
    expect(adapter.takeInvalidation()).toBe(true);
    expect(adapter.takeInvalidation()).toBe(false);
  });
});

describe("enrollment membership", () => {
  it("reports linked, removed, and pending independently of digest confirmation", () => {
    expect(
      enrollmentMembership({
        activeQid: 42n,
        expectedQid: 42n,
        historicallyAdded: true,
      })
    ).toBe("linked");
    expect(
      enrollmentMembership({
        activeQid: null,
        expectedQid: 42n,
        historicallyAdded: true,
      })
    ).toBe("removed");
    expect(
      enrollmentMembership({
        activeQid: null,
        expectedQid: 42n,
        historicallyAdded: false,
      })
    ).toBe("pending");
    expect(
      enrollmentMembership({
        activeQid: 7n,
        expectedQid: 42n,
        historicallyAdded: true,
      })
    ).toBe("wrong-account");
  });

  it("releases the local slot after a terminal digest or settled roster", () => {
    expect(
      occupiesApprovalSlot({
        apiStatus: "submitted",
        membership: "pending",
        operation: "add",
      })
    ).toBe(true);
    expect(
      occupiesApprovalSlot({
        apiStatus: null,
        membership: "pending",
        operation: "add",
      })
    ).toBe(true);
    expect(
      occupiesApprovalSlot({
        apiStatus: "confirmed",
        membership: "pending",
        operation: "add",
      })
    ).toBe(false);
    expect(
      occupiesApprovalSlot({
        apiStatus: "reverted",
        membership: "pending",
        operation: "add",
      })
    ).toBe(false);
    expect(
      occupiesApprovalSlot({
        apiStatus: "submitted",
        membership: "linked",
        operation: "add",
      })
    ).toBe(false);
    expect(
      occupiesApprovalSlot({
        apiStatus: "submitted",
        membership: "linked",
        operation: "remove",
      })
    ).toBe(true);
    expect(
      occupiesApprovalSlot({
        apiStatus: null,
        membership: "removed",
        operation: "remove",
      })
    ).toBe(false);
  });

  it("releases a never-submitted missing digest after the deadline", () => {
    expect(deviceActionDeadlineExpired(1_700_003_600n, 1_700_003_600n)).toBe(
      false
    );
    expect(deviceActionDeadlineExpired(1_700_003_600n, 1_700_003_601n)).toBe(
      true
    );
    expect(
      occupiesApprovalSlot({
        apiRecord: "missing",
        apiStatus: null,
        chainTime: 1_700_003_600n,
        deadline: 1_700_003_600n,
        membership: "pending",
        operation: "add",
      })
    ).toBe(true);
    expect(
      occupiesApprovalSlot({
        apiRecord: "missing",
        apiStatus: null,
        chainTime: 1_700_003_700n,
        deadline: 1_700_003_600n,
        membership: "pending",
        operation: "add",
      })
    ).toBe(false);
    expect(
      occupiesApprovalSlot({
        apiRecord: "missing",
        apiStatus: null,
        chainTime: 1_700_003_000n,
        deadline: 1_700_003_600n,
        membership: "pending",
        operation: "add",
      })
    ).toBe(true);
    expect(
      occupiesApprovalSlot({
        apiRecord: "missing",
        apiStatus: "submitted",
        chainTime: 1_700_003_700n,
        deadline: 1_700_003_600n,
        membership: "pending",
        operation: "add",
      })
    ).toBe(true);
    expect(
      occupiesApprovalSlot({
        apiRecord: "unknown",
        apiStatus: null,
        chainTime: 1_700_003_700n,
        deadline: 1_700_003_600n,
        membership: "pending",
        operation: "add",
      })
    ).toBe(true);
  });

  it("keeps polling a submitted remove until the roster is removed", () => {
    expect(
      enrollmentPollComplete({
        apiStatus: "submitted",
        membership: "linked",
        operation: "remove",
      })
    ).toBe(false);
    expect(
      enrollmentPollComplete({
        apiStatus: "confirmed",
        membership: "linked",
        operation: "remove",
      })
    ).toBe(false);
    expect(
      enrollmentPollComplete({
        apiStatus: "confirmed",
        membership: "removed",
        operation: "remove",
      })
    ).toBe(true);
    expect(
      enrollmentPollComplete({
        apiStatus: "submitted",
        membership: "linked",
        operation: "add",
      })
    ).toBe(true);
    expect(
      enrollmentPollComplete({
        apiStatus: "confirmed",
        membership: "pending",
        operation: "add",
      })
    ).toBe(false);
    expect(
      enrollmentPollComplete({
        apiStatus: "confirmed",
        membership: "linked",
        operation: "add",
      })
    ).toBe(true);
  });
});
