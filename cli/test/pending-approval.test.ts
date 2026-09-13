import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { DeviceActionStatusError } from "../src/device-action-status.ts";
import { loadOccupyingApproval } from "../src/pending-approval.ts";

const pendingAdd = {
  digest: `0x${"ab".repeat(32)}`,
  domain: {
    chainId: "31337",
    verifyingContract: "0x1111111111111111111111111111111111111111",
  },
  expectedOwner: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
  intent: {
    deadline: "1700003600",
    deviceKey: `0x${"09".repeat(32)}`,
    nonce: "9",
    qid: "42",
  },
  operation: "add" as const,
  ownerSignature: `0x${"11".repeat(65)}`,
  v: 1 as const,
};

const createStore = (initial: typeof pendingAdd | null) => {
  let stored: typeof pendingAdd | null = initial;
  return {
    clearApproval: () =>
      Effect.sync(() => {
        stored = null;
      }),
    loadApproval: () => Effect.succeed(stored),
    snapshot: () => stored,
  };
};

describe("CLI pending approval occupancy", () => {
  it.effect(
    "keeps a never-submitted digest when GET is 404 at the deadline",
    () =>
      Effect.gen(function* () {
        const store = createStore(pendingAdd);
        const occupying = yield* loadOccupyingApproval({
          apiUrl: "http://127.0.0.1",
          getStatus: () =>
            Effect.fail(new DeviceActionStatusError({ operation: "missing" })),
          latestTimestamp: () => Effect.succeed(1_700_003_600n),
          store,
        });
        expect(occupying?.digest).toBe(pendingAdd.digest);
        expect(store.snapshot()?.digest).toBe(pendingAdd.digest);
      })
  );

  it.effect(
    "clears a never-submitted digest when GET is 404 after the deadline",
    () =>
      Effect.gen(function* () {
        const store = createStore(pendingAdd);
        const occupying = yield* loadOccupyingApproval({
          apiUrl: "http://127.0.0.1",
          getStatus: () =>
            Effect.fail(new DeviceActionStatusError({ operation: "missing" })),
          latestTimestamp: () => Effect.succeed(1_700_003_601n),
          store,
        });
        expect(occupying).toBeNull();
        expect(store.snapshot()).toBeNull();
      })
  );

  it.effect("keeps a submitted digest on GET 404 after the deadline", () =>
    Effect.gen(function* () {
      const store = createStore(pendingAdd);
      const occupying = yield* loadOccupyingApproval({
        apiUrl: "http://127.0.0.1",
        getStatus: () => Effect.succeed({ status: "submitted" as const }),
        latestTimestamp: () => Effect.succeed(1_700_003_601n),
        store,
      });
      expect(occupying?.digest).toBe(pendingAdd.digest);
      expect(store.snapshot()?.digest).toBe(pendingAdd.digest);
    })
  );

  it.effect("keeps a missing digest when GET fails as a network error", () =>
    Effect.gen(function* () {
      const store = createStore(pendingAdd);
      const occupying = yield* loadOccupyingApproval({
        apiUrl: "http://127.0.0.1",
        getStatus: () =>
          Effect.fail(new DeviceActionStatusError({ operation: "network" })),
        latestTimestamp: () => Effect.succeed(1_700_003_600n),
        store,
      });
      expect(occupying?.digest).toBe(pendingAdd.digest);
      expect(store.snapshot()?.digest).toBe(pendingAdd.digest);
    })
  );
});
