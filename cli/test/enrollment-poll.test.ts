import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { pollEnrollmentState } from "../src/enrollment-poll.ts";

describe("CLI enrollment poll", () => {
  it.effect("does not treat a submitted digest as historically added", () =>
    Effect.gen(function* () {
      let gets = 0;
      const state = yield* pollEnrollmentState({
        delayMs: 0,
        expectedQid: 42n,
        getStatus: () => {
          gets += 1;
          if (gets === 1) {
            return Effect.succeed("submitted" as const);
          }
          return Effect.succeed("confirmed" as const);
        },
        lookup: () => Effect.succeed(null),
      });
      expect(gets).toBeGreaterThan(1);
      expect(state).toBe("removed");
    })
  );

  it.effect("reports linked from a live roster without an approval file", () =>
    Effect.gen(function* () {
      const state = yield* pollEnrollmentState({
        delayMs: 0,
        expectedQid: 42n,
        lookup: () => Effect.succeed({ qid: 42n }),
      });
      expect(state).toBe("linked");
    })
  );
});
