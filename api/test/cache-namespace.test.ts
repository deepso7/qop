import { assert, describe, it } from "@effect/vitest";
import { Deferred, Duration, Effect } from "effect";
import { TestClock } from "effect/testing";

import { makeCacheNamespace } from "../src/cache/namespace.ts";

describe("cache namespace", () => {
  it.effect("coalesces concurrent cache misses", () =>
    Effect.gen(function* () {
      let lookups = 0;
      const cache = yield* makeCacheNamespace({
        capacity: 10,
        lookup: (key: string) =>
          Effect.sync(() => {
            lookups += 1;
            return key.length;
          }),
        policy: {
          freshFor: () => Duration.minutes(1),
          staleFor: () => Duration.minutes(5),
        },
      });

      const results = yield* Effect.all(
        [cache.cached("qop"), cache.cached("qop"), cache.cached("qop")],
        { concurrency: "unbounded" }
      );

      assert.deepStrictEqual(
        results.map((result) => result.value),
        [3, 3, 3]
      );
      assert.strictEqual(lookups, 1);
    })
  );

  it.effect("returns stale data while refreshing it in the background", () =>
    Effect.gen(function* () {
      let origin = "first";
      let lookups = 0;
      const cache = yield* makeCacheNamespace({
        capacity: 10,
        lookup: () =>
          Effect.sync(() => {
            lookups += 1;
            return origin;
          }),
        policy: {
          freshFor: () => Duration.seconds(1),
          staleFor: () => Duration.seconds(10),
        },
      });

      const first = yield* cache.cached("identity");
      origin = "second";
      yield* TestClock.adjust(Duration.seconds(2));
      const stale = yield* cache.cached("identity");
      yield* Effect.yieldNow;
      const refreshed = yield* cache.cached("identity");

      assert.strictEqual(first.value, "first");
      assert.strictEqual(first.freshness, "fresh");
      assert.strictEqual(stale.value, "first");
      assert.strictEqual(stale.freshness, "stale");
      assert.strictEqual(refreshed.value, "second");
      assert.strictEqual(refreshed.freshness, "fresh");
      assert.strictEqual(lookups, 2);
    })
  );

  it.effect("supports an explicit origin refresh", () =>
    Effect.gen(function* () {
      let origin = 1;
      const cache = yield* makeCacheNamespace({
        capacity: 10,
        lookup: () => Effect.sync(() => origin),
        policy: {
          freshFor: () => Duration.hours(1),
          staleFor: () => Duration.hours(2),
        },
      });

      assert.strictEqual((yield* cache.cached("account")).value, 1);
      origin = 2;
      assert.strictEqual((yield* cache.fresh("account")).value, 2);
      assert.strictEqual((yield* cache.cached("account")).value, 2);
    })
  );

  it.effect("discards an in-flight refresh after invalidation", () =>
    Effect.gen(function* () {
      const refreshStarted = yield* Deferred.make<boolean>();
      const releaseRefresh = yield* Deferred.make<boolean>();
      let lookups = 0;
      const cache = yield* makeCacheNamespace({
        capacity: 10,
        lookup: () =>
          Effect.gen(function* () {
            lookups += 1;
            if (lookups === 1) {
              return "initial";
            }
            if (lookups === 2) {
              yield* Deferred.succeed(refreshStarted, true);
              yield* Deferred.await(releaseRefresh);
              return "pre-invalidation";
            }
            return "post-invalidation";
          }),
        policy: {
          freshFor: () => Duration.seconds(1),
          staleFor: () => Duration.minutes(1),
        },
      });

      yield* cache.cached("account");
      yield* TestClock.adjust(Duration.seconds(2));
      assert.strictEqual((yield* cache.cached("account")).value, "initial");
      yield* Deferred.await(refreshStarted);

      yield* cache.invalidate("account");
      const fresh = yield* cache.fresh("account");
      assert.strictEqual(fresh.value, "post-invalidation");

      yield* Deferred.succeed(releaseRefresh, true);
      yield* Effect.yieldNow;
      assert.strictEqual(
        (yield* cache.cached("account")).value,
        "post-invalidation"
      );
      assert.strictEqual(lookups, 3);
    })
  );

  it.effect("bounds detached stale refreshes", () =>
    Effect.gen(function* () {
      const twoRefreshesStarted = yield* Deferred.make<boolean>();
      const releaseRefreshes = yield* Deferred.make<boolean>();
      const twoRefreshesCompleted = yield* Deferred.make<boolean>();
      let active = 0;
      let completed = 0;
      let maximumActive = 0;
      let phase: "refresh" | "seed" = "seed";
      let refreshLookups = 0;
      const cache = yield* makeCacheNamespace({
        capacity: 10,
        lookup: (key: string) =>
          Effect.gen(function* () {
            if (phase === "seed") {
              return `seed-${key}`;
            }

            refreshLookups += 1;
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            if (refreshLookups === 2) {
              yield* Deferred.succeed(twoRefreshesStarted, true);
            }
            yield* Deferred.await(releaseRefreshes);
            active -= 1;
            completed += 1;
            if (completed === 2) {
              yield* Deferred.succeed(twoRefreshesCompleted, true);
            }
            return `refresh-${key}`;
          }),
        policy: {
          freshFor: () => Duration.seconds(1),
          staleFor: () => Duration.minutes(1),
        },
        refreshConcurrency: 2,
      });
      const keys = ["a", "b", "c", "d", "e"];

      for (const key of keys) {
        yield* cache.cached(key);
      }
      phase = "refresh";
      yield* TestClock.adjust(Duration.seconds(2));
      yield* Effect.all(
        keys.map((key) => cache.cached(key)),
        { concurrency: "unbounded" }
      );
      yield* Deferred.await(twoRefreshesStarted);

      assert.strictEqual(maximumActive, 2);
      assert.strictEqual(refreshLookups, 2);
      yield* Deferred.succeed(releaseRefreshes, true);
      yield* Deferred.await(twoRefreshesCompleted);
    })
  );
});
