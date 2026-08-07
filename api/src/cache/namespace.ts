import {
  Cache,
  Clock,
  Duration,
  Effect,
  Exit,
  Option,
  Semaphore,
} from "effect";

export interface CacheNamespacePolicy<Value> {
  readonly freshFor: (value: Value) => Duration.Input;
  readonly staleFor: (value: Value) => Duration.Input;
}

export interface CacheNamespaceRead<Value> {
  readonly cachedAt: number;
  readonly freshness: "fresh" | "stale";
  readonly value: Value;
}

interface CacheEntry<Value> {
  readonly cachedAt: number;
  readonly freshUntil: number;
  readonly staleUntil: number;
  readonly value: Value;
}

export interface CacheNamespace<Key, Value, Error> {
  readonly cached: (
    key: Key
  ) => Effect.Effect<CacheNamespaceRead<Value>, Error>;
  readonly fresh: (key: Key) => Effect.Effect<CacheNamespaceRead<Value>, Error>;
  readonly invalidate: (key: Key) => Effect.Effect<void>;
  readonly invalidateAll: Effect.Effect<void>;
}

export interface CacheNamespaceOptions<Key, Value, Error> {
  readonly backgroundRefreshSemaphore?: Semaphore.Semaphore;
  readonly capacity: number;
  readonly lookup: (key: Key) => Effect.Effect<Value, Error>;
  readonly policy: CacheNamespacePolicy<Value>;
  readonly refreshConcurrency?: number;
  readonly refreshSemaphore?: Semaphore.Semaphore;
}

const durationMillis = (input: Duration.Input): number =>
  Duration.toMillis(Duration.fromInputUnsafe(input));

const cacheRead = <Value>(
  entry: CacheEntry<Value>,
  freshness: CacheNamespaceRead<Value>["freshness"]
): CacheNamespaceRead<Value> => ({
  cachedAt: entry.cachedAt,
  freshness,
  value: entry.value,
});

export const makeCacheNamespace = <Key, Value, Error>(
  options: CacheNamespaceOptions<Key, Value, Error>
): Effect.Effect<CacheNamespace<Key, Value, Error>> =>
  Effect.gen(function* () {
    const refreshSemaphore =
      options.refreshSemaphore ??
      (yield* Semaphore.make(Math.max(1, options.refreshConcurrency ?? 16)));
    const backgroundRefreshSemaphore =
      options.backgroundRefreshSemaphore ??
      (yield* Semaphore.make(Math.max(1, options.refreshConcurrency ?? 16)));
    const mutationSemaphore = yield* Semaphore.make(1);
    let generation = 0;

    const load = Effect.fn("CacheNamespace.load")(function* (key: Key) {
      const value = yield* refreshSemaphore.withPermits(1)(options.lookup(key));
      const cachedAt = yield* Clock.currentTimeMillis;
      const freshFor = durationMillis(options.policy.freshFor(value));
      const staleFor = Math.max(
        freshFor,
        durationMillis(options.policy.staleFor(value))
      );

      return {
        cachedAt,
        freshUntil: cachedAt + freshFor,
        staleUntil: cachedAt + staleFor,
        value,
      } satisfies CacheEntry<Value>;
    });

    const entries = yield* Cache.makeWith<Key, CacheEntry<Value>, Error>(load, {
      capacity: options.capacity,
      timeToLive: (exit) =>
        Exit.isSuccess(exit)
          ? Duration.millis(exit.value.staleUntil - exit.value.cachedAt)
          : Duration.zero,
    });

    const refreshes = yield* Cache.make<
      Key,
      Option.Option<CacheEntry<Value>>,
      Error
    >({
      capacity: options.capacity,
      lookup: Effect.fn("CacheNamespace.refresh")(function* (key: Key) {
        const refreshGeneration = generation;
        const entry = yield* load(key);
        return yield* mutationSemaphore.withPermit(
          Effect.gen(function* () {
            if (generation !== refreshGeneration) {
              return Option.none<CacheEntry<Value>>();
            }
            yield* Cache.set(entries, key, entry);
            return Option.some(entry);
          })
        );
      }),
      timeToLive: Duration.zero,
    });

    const cached = Effect.fn("CacheNamespace.cached")(function* (key: Key) {
      const entry = yield* Cache.get(entries, key);
      const now = yield* Clock.currentTimeMillis;
      if (now < entry.freshUntil) {
        return cacheRead(entry, "fresh");
      }

      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const admitted = yield* backgroundRefreshSemaphore.takeIfAvailable(1);
          if (!admitted) {
            return;
          }

          yield* Effect.forkDetach(
            restore(Cache.get(refreshes, key).pipe(Effect.ignore)).pipe(
              Effect.ensuring(backgroundRefreshSemaphore.release(1))
            )
          );
        })
      );
      return cacheRead(entry, "stale");
    });

    const fresh = Effect.fn("CacheNamespace.fresh")(function* (key: Key) {
      const refreshed = yield* Cache.get(refreshes, key);
      if (Option.isSome(refreshed)) {
        return cacheRead(refreshed.value, "fresh");
      }

      // An invalidation raced the coalesced lookup. Retry once while holding the
      // mutation fence so repeated invalidations cannot turn this into a tight
      // origin-read loop.
      const entry = yield* mutationSemaphore.withPermit(
        Effect.gen(function* () {
          const existing = yield* Cache.getOption(entries, key);
          if (Option.isSome(existing)) {
            return existing.value;
          }
          const loaded = yield* load(key);
          yield* Cache.set(entries, key, loaded);
          return loaded;
        })
      );
      return cacheRead(entry, "fresh");
    });

    const invalidate = Effect.fn("CacheNamespace.invalidate")(function* (
      key: Key
    ) {
      yield* mutationSemaphore.withPermit(
        Effect.gen(function* () {
          generation += 1;
          yield* Cache.invalidate(refreshes, key);
          yield* Cache.invalidate(entries, key);
        })
      );
    });

    const invalidateAll = mutationSemaphore.withPermit(
      Effect.gen(function* () {
        generation += 1;
        yield* Cache.invalidateAll(refreshes);
        yield* Cache.invalidateAll(entries);
      })
    );

    return {
      cached,
      fresh,
      invalidate,
      invalidateAll,
    } satisfies CacheNamespace<Key, Value, Error>;
  });
