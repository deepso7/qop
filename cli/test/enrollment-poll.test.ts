import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { pollEnrollmentState } from "../src/enrollment-poll.ts";

describe("CLI enrollment poll", () => {
  it.effect("keeps polling after API confirmed until the roster agrees", () =>
    Effect.gen(function* () {
      let lookups = 0;
      const snapshot = yield* pollEnrollmentState({
        delayMs: 0,
        expectedQid: 42n,
        getStatus: () => Effect.succeed("confirmed" as const),
        lookup: () => {
          lookups += 1;
          return Effect.succeed(lookups >= 3 ? { qid: 42n } : null);
        },
        maxAttempts: 10,
      });
      expect(lookups).toBeGreaterThan(1);
      expect(snapshot.state).toBe("linked");
      expect(snapshot.historicallyAdded).toBe(true);
      expect(snapshot.apiStatus).toBe("confirmed");
    })
  );

  it.effect("does not treat API confirmed without a roster as removed", () =>
    Effect.gen(function* () {
      const snapshot = yield* pollEnrollmentState({
        delayMs: 0,
        expectedQid: 42n,
        getStatus: () => Effect.succeed("confirmed" as const),
        lookup: () => Effect.succeed(null),
        maxAttempts: 3,
      });
      expect(snapshot.state).toBe("pending");
      expect(snapshot.historicallyAdded).toBe(false);
      expect(snapshot.apiStatus).toBe("confirmed");
    })
  );

  it.effect("reports linked from a live roster without an approval file", () =>
    Effect.gen(function* () {
      const snapshot = yield* pollEnrollmentState({
        delayMs: 0,
        expectedQid: 42n,
        lookup: () => Effect.succeed({ qid: 42n }),
      });
      expect(snapshot.state).toBe("linked");
    })
  );

  it.effect("treats expired and reverted statuses as terminal pending", () =>
    Effect.gen(function* () {
      const expired = yield* pollEnrollmentState({
        delayMs: 0,
        expectedQid: 42n,
        getStatus: () => Effect.succeed("expired" as const),
        lookup: () => Effect.succeed(null),
      });
      expect(expired.state).toBe("pending");
      expect(expired.apiStatus).toBe("expired");
      expect(expired.historicallyAdded).toBe(false);

      const reverted = yield* pollEnrollmentState({
        delayMs: 0,
        expectedQid: 42n,
        getStatus: () => Effect.succeed("reverted" as const),
        lookup: () => Effect.succeed(null),
      });
      expect(reverted.state).toBe("pending");
      expect(reverted.apiStatus).toBe("reverted");
    })
  );

  it.effect("stops after maxAttempts when status requests keep failing", () =>
    Effect.gen(function* () {
      let gets = 0;
      const snapshot = yield* pollEnrollmentState({
        delayMs: 0,
        expectedQid: 42n,
        getStatus: () => {
          gets += 1;
          return Effect.fail(new Error("unavailable"));
        },
        lookup: () => Effect.succeed(null),
        maxAttempts: 3,
      });
      expect(gets).toBe(3);
      expect(snapshot.state).toBe("pending");
      expect(snapshot.apiStatus).toBeNull();
    })
  );
});
