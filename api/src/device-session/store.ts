import type { DeviceSessionChallengeV1Encoded } from "@qop/identity";
import { and, asc, eq, gt, inArray, isNull, lte, ne, or } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Context, Data, DateTime, Effect, Layer, Option } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Hash } from "viem";

import { Database, DatabaseLive } from "../db/database.ts";
import {
  deviceCertificates,
  deviceSessionChallenges,
  deviceSessions,
} from "../db/schema.ts";

export type StoredDeviceSessionChallenge = InferSelectModel<
  typeof deviceSessionChallenges
>;
export type StoredDeviceSession = InferSelectModel<typeof deviceSessions>;

export const deviceSessionPurgeBatchSize = 100;

export interface CreateDeviceSessionChallenge {
  readonly challenge: DeviceSessionChallengeV1Encoded;
  readonly challengeHash: Hash;
}

export interface AuthenticateDeviceSession {
  readonly challengeHash: Hash;
  readonly ownerVersion: number;
  readonly sessionTtlSeconds: bigint;
  readonly tokenHash: Hash;
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

export class DeviceSessionExpired extends Data.TaggedError(
  "DeviceSessionExpired"
)<{ readonly tokenHash: Hash }> {}

export class DeviceSessionNotFound extends Data.TaggedError(
  "DeviceSessionNotFound"
)<{ readonly tokenHash: Hash }> {}

export type DeviceSessionStorePersistenceError =
  | EffectDrizzleQueryError
  | SqlError;

export type DeviceSessionStoreError =
  | DeviceSessionChallengeConsumed
  | DeviceSessionChallengeExpired
  | DeviceSessionChallengeNotFound
  | DeviceSessionExpired
  | DeviceSessionNotFound
  | DeviceSessionStorePersistenceError;

export interface DeviceSessionStoreShape {
  readonly authenticate: (
    input: AuthenticateDeviceSession
  ) => Effect.Effect<StoredDeviceSession, DeviceSessionStoreError>;
  readonly consumeChallenge: (
    challengeHash: Hash
  ) => Effect.Effect<StoredDeviceSessionChallenge, DeviceSessionStoreError>;
  readonly createChallenge: (
    input: CreateDeviceSessionChallenge
  ) => Effect.Effect<
    StoredDeviceSessionChallenge,
    DeviceSessionStorePersistenceError
  >;
  readonly getActiveSession: (
    tokenHash: Hash
  ) => Effect.Effect<StoredDeviceSession, DeviceSessionStoreError>;
  readonly getChallenge: (
    challengeHash: Hash
  ) => Effect.Effect<
    Option.Option<StoredDeviceSessionChallenge>,
    DeviceSessionStorePersistenceError
  >;
  readonly purgeExpired: Effect.Effect<
    number,
    DeviceSessionStorePersistenceError
  >;
}

const epochSeconds = (dateTime: DateTime.Utc): bigint =>
  BigInt(Math.floor(DateTime.toEpochMillis(dateTime) / 1000));

export class DeviceSessionStore extends Context.Service<
  DeviceSessionStore,
  DeviceSessionStoreShape
>()("@qop/api/DeviceSessionStore") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const { client: db } = yield* Database;

      const getChallenge = Effect.fn("DeviceSessionStore.getChallenge")(
        function* (challengeHash: Hash) {
          const rows = yield* db
            .select()
            .from(deviceSessionChallenges)
            .where(eq(deviceSessionChallenges.challengeHash, challengeHash))
            .limit(1);
          return Option.fromUndefinedOr(rows.at(0));
        }
      );

      const createChallenge = Effect.fn("DeviceSessionStore.createChallenge")(
        function* (input: CreateDeviceSessionChallenge) {
          const challenge: typeof deviceSessionChallenges.$inferInsert = {
            certificateDigest: input.challenge.certificateDigest as Hash,
            challenge: input.challenge.challenge,
            challengeHash: input.challengeHash,
            expiresAt: BigInt(input.challenge.expiresAt),
            issuedAt: BigInt(input.challenge.issuedAt),
            peerId: input.challenge.peerId,
            qid: BigInt(input.challenge.qid),
            verifier: input.challenge.verifier,
            version: input.challenge.version,
          };
          const currentSeconds = epochSeconds(yield* DateTime.now);
          return yield* db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .select({
                  certificateDigest: deviceCertificates.certificateDigest,
                })
                .from(deviceCertificates)
                .where(
                  eq(
                    deviceCertificates.certificateDigest,
                    challenge.certificateDigest
                  )
                )
                .for("update");
              const existing = yield* tx
                .select()
                .from(deviceSessionChallenges)
                .where(
                  and(
                    eq(
                      deviceSessionChallenges.certificateDigest,
                      challenge.certificateDigest
                    ),
                    eq(deviceSessionChallenges.verifier, challenge.verifier),
                    isNull(deviceSessionChallenges.consumedAt),
                    gt(deviceSessionChallenges.expiresAt, currentSeconds)
                  )
                )
                .limit(1);
              const active = existing.at(0);
              if (active) {
                return active;
              }
              yield* tx
                .delete(deviceSessionChallenges)
                .where(
                  and(
                    eq(
                      deviceSessionChallenges.certificateDigest,
                      challenge.certificateDigest
                    ),
                    isNull(deviceSessionChallenges.consumedAt),
                    or(
                      lte(deviceSessionChallenges.expiresAt, currentSeconds),
                      ne(deviceSessionChallenges.verifier, challenge.verifier)
                    )
                  )
                );
              const rows = yield* tx
                .insert(deviceSessionChallenges)
                .values(challenge)
                .returning();
              return rows[0] as StoredDeviceSessionChallenge;
            })
          );
        }
      );

      const consumeChallenge = Effect.fn("DeviceSessionStore.consumeChallenge")(
        function* (challengeHash: Hash) {
          const now = yield* DateTime.now;
          const currentSeconds = epochSeconds(now);
          const consumedAt = DateTime.toDateUtc(now);
          const rows = yield* db
            .update(deviceSessionChallenges)
            .set({ consumedAt })
            .where(
              and(
                eq(deviceSessionChallenges.challengeHash, challengeHash),
                isNull(deviceSessionChallenges.consumedAt),
                gt(deviceSessionChallenges.expiresAt, currentSeconds)
              )
            )
            .returning();
          const consumed = rows.at(0);
          if (consumed) {
            return consumed;
          }
          const existing = yield* getChallenge(challengeHash);
          if (Option.isNone(existing)) {
            return yield* new DeviceSessionChallengeNotFound({ challengeHash });
          }
          if (existing.value.consumedAt !== null) {
            return yield* new DeviceSessionChallengeConsumed({ challengeHash });
          }
          return yield* new DeviceSessionChallengeExpired({ challengeHash });
        }
      );

      const authenticate = Effect.fn("DeviceSessionStore.authenticate")(
        function* (input: AuthenticateDeviceSession) {
          const now = yield* DateTime.now;
          const currentSeconds = epochSeconds(now);
          const createdAt = DateTime.toDateUtc(now);
          return yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const consumed = yield* tx
                .update(deviceSessionChallenges)
                .set({ consumedAt: createdAt })
                .where(
                  and(
                    eq(
                      deviceSessionChallenges.challengeHash,
                      input.challengeHash
                    ),
                    isNull(deviceSessionChallenges.consumedAt),
                    gt(deviceSessionChallenges.expiresAt, currentSeconds)
                  )
                )
                .returning();
              const challenge = consumed.at(0);
              if (!challenge) {
                const rows = yield* tx
                  .select()
                  .from(deviceSessionChallenges)
                  .where(
                    eq(
                      deviceSessionChallenges.challengeHash,
                      input.challengeHash
                    )
                  )
                  .limit(1);
                const existing = rows.at(0);
                if (!existing) {
                  return yield* new DeviceSessionChallengeNotFound({
                    challengeHash: input.challengeHash,
                  });
                }
                if (existing.consumedAt !== null) {
                  return yield* new DeviceSessionChallengeConsumed({
                    challengeHash: input.challengeHash,
                  });
                }
                return yield* new DeviceSessionChallengeExpired({
                  challengeHash: input.challengeHash,
                });
              }

              const sessions = yield* tx
                .insert(deviceSessions)
                .values({
                  certificateDigest: challenge.certificateDigest,
                  createdAt,
                  expiresAt: currentSeconds + input.sessionTtlSeconds,
                  ownerVersion: input.ownerVersion,
                  peerId: challenge.peerId,
                  qid: challenge.qid,
                  tokenHash: input.tokenHash,
                })
                .returning();
              return sessions[0] as StoredDeviceSession;
            })
          );
        }
      );

      const getActiveSession = Effect.fn("DeviceSessionStore.getActiveSession")(
        function* (tokenHash: Hash) {
          const rows = yield* db
            .select()
            .from(deviceSessions)
            .where(eq(deviceSessions.tokenHash, tokenHash))
            .limit(1);
          const session = rows.at(0);
          if (!session) {
            return yield* new DeviceSessionNotFound({ tokenHash });
          }
          if (session.expiresAt <= epochSeconds(yield* DateTime.now)) {
            return yield* new DeviceSessionExpired({ tokenHash });
          }
          return session;
        }
      );

      const purgeExpired = Effect.gen(function* () {
        const currentSeconds = epochSeconds(yield* DateTime.now);
        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const challengeCandidates = yield* tx
              .select({ challengeHash: deviceSessionChallenges.challengeHash })
              .from(deviceSessionChallenges)
              .where(lte(deviceSessionChallenges.expiresAt, currentSeconds))
              .orderBy(
                asc(deviceSessionChallenges.expiresAt),
                asc(deviceSessionChallenges.challengeHash)
              )
              .limit(deviceSessionPurgeBatchSize);
            const challengeHashes = challengeCandidates.map(
              (row) => row.challengeHash
            );
            const deletedChallenges =
              challengeHashes.length === 0
                ? []
                : yield* tx
                    .delete(deviceSessionChallenges)
                    .where(
                      and(
                        inArray(
                          deviceSessionChallenges.challengeHash,
                          challengeHashes
                        ),
                        lte(deviceSessionChallenges.expiresAt, currentSeconds)
                      )
                    )
                    .returning({
                      challengeHash: deviceSessionChallenges.challengeHash,
                    });

            const sessionCandidates = yield* tx
              .select({ tokenHash: deviceSessions.tokenHash })
              .from(deviceSessions)
              .where(lte(deviceSessions.expiresAt, currentSeconds))
              .orderBy(
                asc(deviceSessions.expiresAt),
                asc(deviceSessions.tokenHash)
              )
              .limit(deviceSessionPurgeBatchSize);
            const tokenHashes = sessionCandidates.map((row) => row.tokenHash);
            const deletedSessions =
              tokenHashes.length === 0
                ? []
                : yield* tx
                    .delete(deviceSessions)
                    .where(
                      and(
                        inArray(deviceSessions.tokenHash, tokenHashes),
                        lte(deviceSessions.expiresAt, currentSeconds)
                      )
                    )
                    .returning({ tokenHash: deviceSessions.tokenHash });
            return deletedChallenges.length + deletedSessions.length;
          })
        );
      });

      return DeviceSessionStore.of({
        authenticate,
        consumeChallenge,
        createChallenge,
        getActiveSession,
        getChallenge,
        purgeExpired,
      });
    })
  );
}

export const DeviceSessionStoreLive = DeviceSessionStore.layer.pipe(
  Layer.provide(DatabaseLive)
);
