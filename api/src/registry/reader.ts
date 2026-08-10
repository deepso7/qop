import { Context, Duration, Effect, Layer, Semaphore } from "effect";
import type { Address, Hash } from "viem";

import { makeCacheNamespace } from "../cache/namespace.ts";
import type { CacheNamespaceRead } from "../cache/namespace.ts";
import { RegistryChain, RegistryChainLive } from "./chain.ts";
import type { RegistryChainReadError } from "./chain.ts";
import {
  normalizeCertificateDigest,
  normalizeRegistryHandle,
  normalizeRegistryOwner,
} from "./inputs.ts";
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
  readonly deviceRevocation: (
    qid: bigint,
    certificateDigest: Hash
  ) => Effect.Effect<RegistryRead<boolean>, RegistryChainReadError>;
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
  readonly deviceRevocation: (
    qid: bigint,
    certificateDigest: Hash
  ) => Effect.Effect<void, RegistryInputError>;
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

export interface RegistryReaderShape {
  readonly cached: RegistryReads;
  readonly fresh: RegistryFreshReads;
  readonly invalidate: RegistryInvalidations;
}

const policy = {
  account: {
    freshFor: () => Duration.seconds(15),
    staleFor: () => Duration.minutes(1),
  },
  deviceRevocation: {
    freshFor: (snapshot: RegistrySnapshot<boolean>) =>
      snapshot.value ? Duration.days(1) : Duration.seconds(15),
    staleFor: (snapshot: RegistrySnapshot<boolean>) =>
      snapshot.value ? Duration.days(7) : Duration.minutes(1),
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

const revocationKey = (qid: bigint, certificateDigest: Hash): string =>
  `${qid}:${certificateDigest}`;

const parseRevocationKey = (
  key: string
): readonly [qid: bigint, certificateDigest: Hash] => {
  const separator = key.indexOf(":");
  return [BigInt(key.slice(0, separator)), key.slice(separator + 1) as Hash];
};

export class RegistryReader extends Context.Service<
  RegistryReader,
  RegistryReaderShape
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
      const accounts = yield* makeCacheNamespace({
        ...cacheOptions,
        capacity: 10_000,
        lookup: chain.account,
        policy: policy.account,
      });
      const handles = yield* makeCacheNamespace({
        ...cacheOptions,
        capacity: 10_000,
        lookup: chain.qidByHandle,
        policy: policy.qidByHandle,
      });
      const owners = yield* makeCacheNamespace({
        ...cacheOptions,
        capacity: 10_000,
        lookup: chain.qidByOwner,
        policy: policy.qidByOwner,
      });
      const revocations = yield* makeCacheNamespace({
        ...cacheOptions,
        capacity: 50_000,
        lookup: (key: string) => {
          const [qid, certificateDigest] = parseRevocationKey(key);
          return chain.deviceRevocation(qid, certificateDigest);
        },
        policy: policy.deviceRevocation,
      });

      const reads = (mode: "cached" | "fresh"): RegistryReads => ({
        account: (qid) => accounts[mode](qid).pipe(Effect.map(flatten)),
        deviceRevocation: (qid, certificateDigest) =>
          normalizeCertificateDigest(certificateDigest).pipe(
            Effect.flatMap((canonicalDigest) =>
              revocations[mode](revocationKey(qid, canonicalDigest))
            ),
            Effect.map(flatten)
          ),
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

      const fresh: RegistryFreshReads = {
        ...reads("fresh"),
        registrationProbe: chain.registrationProbe,
      };

      return RegistryReader.of({
        cached: reads("cached"),
        fresh,
        invalidate: {
          account: accounts.invalidate,
          all: Effect.all(
            [
              accounts.invalidateAll,
              handles.invalidateAll,
              owners.invalidateAll,
              revocations.invalidateAll,
            ],
            { discard: true }
          ),
          deviceRevocation: (qid, certificateDigest) =>
            normalizeCertificateDigest(certificateDigest).pipe(
              Effect.flatMap((canonicalDigest) =>
                revocations.invalidate(revocationKey(qid, canonicalDigest))
              )
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
