import { Context, Duration, Effect, Layer, Semaphore } from "effect";
import type { Address, Hash } from "viem";

import { createCacheNamespace } from "../cache/namespace.ts";
import type { CacheNamespaceRead } from "../cache/namespace.ts";
import { RegistryChain, RegistryChainLive } from "./chain.ts";
import type { RegistryChainReadError } from "./chain.ts";
import { normalizeRegistryHandle, normalizeRegistryOwner } from "./inputs.ts";
import type { RegistryInputError } from "./inputs.ts";
import type {
  RegistryAccount,
  RegistryRegistrationProbe,
  RegistrySnapshot,
} from "./types.ts";

export interface RegistryRead<Value> {
  readonly blockNumber: bigint;
  readonly cachedAt: number;
  readonly freshness: "fresh" | "stale";
  readonly value: Value;
}

export interface RegistryReads {
  readonly account: (
    qid: bigint
  ) => Effect.Effect<RegistryRead<RegistryAccount>, RegistryChainReadError>;
  readonly qidByHandle: (
    handle: string
  ) => Effect.Effect<RegistryRead<bigint | null>, RegistryChainReadError>;
  readonly qidByOwner: (
    owner: Address
  ) => Effect.Effect<RegistryRead<bigint | null>, RegistryChainReadError>;
}

export interface RegistryFreshReads extends RegistryReads {
  readonly registrationProbe: (
    handle: string,
    owner: Address,
    registrationNonce: Hash
  ) => Effect.Effect<
    RegistrySnapshot<RegistryRegistrationProbe>,
    RegistryChainReadError
  >;
}

export interface RegistryInvalidations {
  readonly account: (qid: bigint) => Effect.Effect<void>;
  readonly all: Effect.Effect<void>;
  readonly ownerRotation: (
    qid: bigint,
    previousOwner: Address,
    newOwner: Address
  ) => Effect.Effect<void, RegistryInputError>;
  readonly qidByHandle: (
    handle: string
  ) => Effect.Effect<void, RegistryInputError>;
  readonly qidByOwner: (
    owner: Address
  ) => Effect.Effect<void, RegistryInputError>;
}

export interface RegistryReaderContract {
  readonly cached: RegistryReads;
  readonly fresh: RegistryFreshReads;
  readonly invalidate: RegistryInvalidations;
}

const policy = {
  account: {
    freshFor: () => Duration.seconds(15),
    staleFor: () => Duration.minutes(1),
  },
  qidByHandle: {
    freshFor: (snapshot: RegistrySnapshot<bigint | null>) =>
      snapshot.value === null ? Duration.seconds(10) : Duration.days(1),
    staleFor: (snapshot: RegistrySnapshot<bigint | null>) =>
      snapshot.value === null ? Duration.seconds(30) : Duration.days(7),
  },
  qidByOwner: {
    freshFor: () => Duration.seconds(15),
    staleFor: () => Duration.minutes(1),
  },
} as const;

const flatten = <Value>(
  read: CacheNamespaceRead<RegistrySnapshot<Value>>
): RegistryRead<Value> => ({
  blockNumber: read.value.blockNumber,
  cachedAt: read.cachedAt,
  freshness: read.freshness,
  value: read.value.value,
});

export class RegistryReader extends Context.Service<
  RegistryReader,
  RegistryReaderContract
>()("@qop/api/RegistryReader") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const chain = yield* RegistryChain;
      const refreshSemaphore = yield* Semaphore.make(16);
      const backgroundRefreshSemaphore = yield* Semaphore.make(16);
      const cacheOptions = {
        backgroundRefreshSemaphore,
        refreshSemaphore,
      } as const;
      const accounts = yield* createCacheNamespace({
        ...cacheOptions,
        capacity: 10_000,
        lookup: chain.account,
        policy: policy.account,
      });
      const handles = yield* createCacheNamespace({
        ...cacheOptions,
        capacity: 10_000,
        lookup: chain.qidByHandle,
        policy: policy.qidByHandle,
      });
      const owners = yield* createCacheNamespace({
        ...cacheOptions,
        capacity: 10_000,
        lookup: chain.qidByOwner,
        policy: policy.qidByOwner,
      });

      const reads = (mode: "cached" | "fresh"): RegistryReads => ({
        account: (qid) => accounts[mode](qid).pipe(Effect.map(flatten)),
        qidByHandle: (handle) =>
          normalizeRegistryHandle(handle).pipe(
            Effect.flatMap(handles[mode]),
            Effect.map(flatten)
          ),
        qidByOwner: (owner) =>
          normalizeRegistryOwner(owner).pipe(
            Effect.flatMap(owners[mode]),
            Effect.map(flatten)
          ),
      });

      return RegistryReader.of({
        cached: reads("cached"),
        fresh: {
          ...reads("fresh"),
          registrationProbe: chain.registrationProbe,
        },
        invalidate: {
          account: accounts.invalidate,
          all: Effect.all(
            [
              accounts.invalidateAll,
              handles.invalidateAll,
              owners.invalidateAll,
            ],
            { discard: true }
          ),
          ownerRotation: (qid, previousOwner, newOwner) =>
            Effect.all([
              normalizeRegistryOwner(previousOwner),
              normalizeRegistryOwner(newOwner),
            ]).pipe(
              Effect.flatMap(([canonicalPreviousOwner, canonicalNewOwner]) =>
                Effect.all(
                  [
                    accounts.invalidate(qid),
                    owners.invalidate(canonicalPreviousOwner),
                    owners.invalidate(canonicalNewOwner),
                  ],
                  { discard: true }
                )
              )
            ),
          qidByHandle: (handle) =>
            normalizeRegistryHandle(handle).pipe(
              Effect.flatMap(handles.invalidate)
            ),
          qidByOwner: (owner) =>
            normalizeRegistryOwner(owner).pipe(
              Effect.flatMap(owners.invalidate)
            ),
        },
      });
    })
  );
}

export const RegistryReaderLive = RegistryReader.layer.pipe(
  Layer.provide(RegistryChainLive)
);
