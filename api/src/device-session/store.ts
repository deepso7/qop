import type { DeviceSessionChallengeV1Encoded } from "@qop/identity";
import { and, asc, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Context, Data, DateTime, Effect, Layer, Option } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Hash } from "viem";

import { Database, DatabaseLive } from "../db/database.ts";
import { deviceSessionChallenges } from "../db/schema.ts";

export type StoredDeviceSessionChallenge = InferSelectModel<
  typeof deviceSessionChallenges
>;

export const deviceSessionChallengePurgeBatchSize = 100;

export interface CreateDeviceSessionChallenge {
  readonly challenge: DeviceSessionChallengeV1Encoded;
  readonly challengeHash: Hash;
}

export class DeviceSessionChallengeConsumed extends Data.TaggedError(
  "DeviceSessionChallengeConsumed"
)<{ readonly challengeHash: Hash }> {}

export class DeviceSessionChallengeExpired extends Data.TaggedError(
  "DeviceSessionChallengeExpired"
)<{ readonly challengeHash: Hash }> {}

export class DeviceSessionChallengeNotFound extends Data.TaggedError(
  "DeviceSessionChallengeNotFound"
)<{ readonly challengeHash: Hash }> {}

export type DeviceSessionChallengeStorePersistenceError =
  | EffectDrizzleQueryError
  | SqlError;

export type DeviceSessionChallengeStoreError =
  | DeviceSessionChallengeConsumed
  | DeviceSessionChallengeExpired
  | DeviceSessionChallengeNotFound
  | DeviceSessionChallengeStorePersistenceError;

export interface DeviceSessionChallengeStoreShape {
  readonly consume: (
    challengeHash: Hash
  ) => Effect.Effect<
    StoredDeviceSessionChallenge,
    DeviceSessionChallengeStoreError
  >;
  readonly create: (
    input: CreateDeviceSessionChallenge
  ) => Effect.Effect<
    StoredDeviceSessionChallenge,
    DeviceSessionChallengeStorePersistenceError
  >;
  readonly get: (
    challengeHash: Hash
  ) => Effect.Effect<
    Option.Option<StoredDeviceSessionChallenge>,
    DeviceSessionChallengeStorePersistenceError
  >;
  readonly purgeExpired: Effect.Effect<
    number,
    DeviceSessionChallengeStorePersistenceError
  >;
}

export class DeviceSessionChallengeStore extends Context.Service<
  DeviceSessionChallengeStore,
  DeviceSessionChallengeStoreShape
>()("@qop/api/DeviceSessionChallengeStore") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const { client: db } = yield* Database;

      const get = Effect.fn("DeviceSessionChallengeStore.get")(function* (
        challengeHash: Hash
      ) {
        const rows = yield* db
          .select()
          .from(deviceSessionChallenges)
          .where(eq(deviceSessionChallenges.challengeHash, challengeHash))
          .limit(1);
        return Option.fromUndefinedOr(rows.at(0));
      });

      const create = Effect.fn("DeviceSessionChallengeStore.create")(function* (
        input: CreateDeviceSessionChallenge
      ) {
        const challenge: typeof deviceSessionChallenges.$inferInsert = {
          certificateDigest: input.challenge.certificateDigest as Hash,
          challengeHash: input.challengeHash,
          expiresAt: BigInt(input.challenge.expiresAt),
          flow: input.challenge.flow,
          issuedAt: BigInt(input.challenge.issuedAt),
          peerId: input.challenge.peerId,
          qid: BigInt(input.challenge.qid),
          version: input.challenge.version,
        };
        const rows = yield* db
          .insert(deviceSessionChallenges)
          .values(challenge)
          .returning();
        return rows[0] as StoredDeviceSessionChallenge;
      });

      const consume = Effect.fn("DeviceSessionChallengeStore.consume")(
        function* (challengeHash: Hash) {
          const now = yield* DateTime.now;
          const nowSeconds = BigInt(
            Math.floor(DateTime.toEpochMillis(now) / 1000)
          );
          const consumedAt = DateTime.toDateUtc(now);
          const rows = yield* db
            .update(deviceSessionChallenges)
            .set({ consumedAt })
            .where(
              and(
                eq(deviceSessionChallenges.challengeHash, challengeHash),
                isNull(deviceSessionChallenges.consumedAt),
                gt(deviceSessionChallenges.expiresAt, nowSeconds)
              )
            )
            .returning();
          const consumed = rows.at(0);
          if (consumed) {
            return consumed;
          }
          const existing = yield* get(challengeHash);
          if (Option.isNone(existing)) {
            return yield* new DeviceSessionChallengeNotFound({ challengeHash });
          }
          if (existing.value.consumedAt !== null) {
            return yield* new DeviceSessionChallengeConsumed({ challengeHash });
          }
          return yield* new DeviceSessionChallengeExpired({ challengeHash });
        }
      );

      const purgeExpired = Effect.gen(function* () {
        const now = yield* DateTime.now;
        const currentSeconds = BigInt(
          Math.floor(DateTime.toEpochMillis(now) / 1000)
        );
        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const candidates = yield* tx
              .select({ challengeHash: deviceSessionChallenges.challengeHash })
              .from(deviceSessionChallenges)
              .where(lte(deviceSessionChallenges.expiresAt, currentSeconds))
              .orderBy(
                asc(deviceSessionChallenges.expiresAt),
                asc(deviceSessionChallenges.challengeHash)
              )
              .limit(deviceSessionChallengePurgeBatchSize);
            const hashes = candidates.map((row) => row.challengeHash);
            if (hashes.length === 0) {
              return 0;
            }
            const deleted = yield* tx
              .delete(deviceSessionChallenges)
              .where(
                and(
                  inArray(deviceSessionChallenges.challengeHash, hashes),
                  lte(deviceSessionChallenges.expiresAt, currentSeconds)
                )
              )
              .returning({
                challengeHash: deviceSessionChallenges.challengeHash,
              });
            return deleted.length;
          })
        );
      });

      return DeviceSessionChallengeStore.of({
        consume,
        create,
        get,
        purgeExpired,
      });
    })
  );
}

export const DeviceSessionChallengeStoreLive =
  DeviceSessionChallengeStore.layer.pipe(Layer.provide(DatabaseLive));
