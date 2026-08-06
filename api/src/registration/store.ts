import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Context, Data, DateTime, Effect, Layer, Option } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Hash } from "viem";

import { Database, DatabaseLive } from "../db/database.ts";
import type { DatabaseClient } from "../db/database.ts";
import { registrationHandleLeases, registrationIntents } from "../db/schema.ts";
import {
  normalizeCreateRegistrationIntent,
  normalizeRegistrationAuthorization,
  normalizeRegistrationDigest,
  normalizeRegistrationQid,
  normalizeTransactionHash,
} from "./inputs.ts";
import type { RegistrationInputError } from "./inputs.ts";
import { registrationTransitionSources } from "./state.ts";
import type {
  CreateRegistrationIntent,
  RegistrationAuthorization,
  RegistrationIntentStatus,
} from "./types.ts";

export type StoredRegistrationIntent = InferSelectModel<
  typeof registrationIntents
>;

type TransactionCallback = Parameters<DatabaseClient["transaction"]>[0];
type Transaction = Parameters<TransactionCallback>[0];

const find = (
  client: DatabaseClient | Transaction,
  digest: Hash
): Effect.Effect<
  StoredRegistrationIntent | undefined,
  RegistrationStorePersistenceError
> =>
  client
    .select()
    .from(registrationIntents)
    .where(eq(registrationIntents.digest, digest))
    .limit(1)
    .pipe(Effect.map((rows) => rows.at(0)));

const findLeaseDigest = (
  client: DatabaseClient | Transaction,
  handle: string
): Effect.Effect<Hash | undefined, RegistrationStorePersistenceError> =>
  client
    .select({ digest: registrationHandleLeases.intentDigest })
    .from(registrationHandleLeases)
    .where(eq(registrationHandleLeases.handle, handle))
    .limit(1)
    .pipe(Effect.map((rows) => rows.at(0)?.digest as Hash | undefined));

export class HandleLeaseConflict extends Data.TaggedError(
  "HandleLeaseConflict"
)<{ readonly handle: string }> {}

export class RegistrationIntentConflict extends Data.TaggedError(
  "RegistrationIntentConflict"
)<{ readonly digest: string }> {}

export class RegistrationIntentExpired extends Data.TaggedError(
  "RegistrationIntentExpired"
)<{ readonly digest: string }> {}

export class RegistrationIntentNotFound extends Data.TaggedError(
  "RegistrationIntentNotFound"
)<{ readonly digest: string }> {}

export class RegistrationTransitionConflict extends Data.TaggedError(
  "RegistrationTransitionConflict"
)<{
  readonly actual: string;
  readonly digest: string;
  readonly expected: readonly string[];
}> {}

export type RegistrationStorePersistenceError =
  | EffectDrizzleQueryError
  | SqlError;

export type RegistrationStoreError =
  | HandleLeaseConflict
  | RegistrationInputError
  | RegistrationIntentConflict
  | RegistrationIntentExpired
  | RegistrationIntentNotFound
  | RegistrationStorePersistenceError
  | RegistrationTransitionConflict;

export interface RegistrationStoreShape {
  readonly authorize: (
    digest: Hash,
    authorization: RegistrationAuthorization
  ) => Effect.Effect<StoredRegistrationIntent, RegistrationStoreError>;
  readonly create: (
    input: CreateRegistrationIntent
  ) => Effect.Effect<StoredRegistrationIntent, RegistrationStoreError>;
  readonly expire: Effect.Effect<number, RegistrationStorePersistenceError>;
  readonly get: (
    digest: Hash
  ) => Effect.Effect<
    Option.Option<StoredRegistrationIntent>,
    RegistrationInputError | RegistrationStorePersistenceError
  >;
  readonly markConfirmed: (
    digest: Hash,
    qid: bigint
  ) => Effect.Effect<StoredRegistrationIntent, RegistrationStoreError>;
  readonly markFailed: (
    digest: Hash,
    failureCode: string
  ) => Effect.Effect<StoredRegistrationIntent, RegistrationStoreError>;
  readonly markSubmitted: (
    digest: Hash,
    transactionHash: Hash
  ) => Effect.Effect<StoredRegistrationIntent, RegistrationStoreError>;
}

const activeStatuses: readonly RegistrationIntentStatus[] =
  registrationTransitionSources.fail;
const expirableStatuses: readonly RegistrationIntentStatus[] =
  registrationTransitionSources.expire;

export const registrationExpirationBatchSize = 100;

const epochSeconds = (value: DateTime.DateTime): bigint =>
  BigInt(Math.floor(DateTime.toEpochMillis(value) / 1000));

export class RegistrationStore extends Context.Service<
  RegistrationStore,
  RegistrationStoreShape
>()("@qop/api/RegistrationStore") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const { client: db } = yield* Database;

      const transitionFailure = Effect.fn(
        "RegistrationStore.transitionFailure"
      )(function* (
        tx: Transaction,
        digest: Hash,
        expected: readonly RegistrationIntentStatus[],
        now: bigint
      ): Effect.fn.Return<never, RegistrationStoreError> {
        const current = yield* find(tx, digest);
        if (!current) {
          return yield* new RegistrationIntentNotFound({ digest });
        }
        if (
          current.deadline < now &&
          expirableStatuses.includes(current.status)
        ) {
          return yield* new RegistrationIntentExpired({ digest });
        }
        return yield* new RegistrationTransitionConflict({
          actual: current.status,
          digest,
          expected,
        });
      });

      const get = Effect.fn("RegistrationStore.get")(function* (digest: Hash) {
        const canonicalDigest = yield* normalizeRegistrationDigest(digest);
        return Option.fromUndefinedOr(yield* find(db, canonicalDigest));
      });

      const create = Effect.fn("RegistrationStore.create")(function* (
        input: CreateRegistrationIntent
      ) {
        const canonicalInput = yield* normalizeCreateRegistrationIntent(input);
        const now = yield* DateTime.now;
        const nowSeconds = epochSeconds(now);
        const nowDate = DateTime.toDateUtc(now);

        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const existing = yield* find(tx, canonicalInput.digest);
            if (existing) {
              const isExactReplay =
                existing.deadline === canonicalInput.deadline &&
                existing.handle === canonicalInput.handle &&
                existing.observeTokenHash === canonicalInput.observeTokenHash &&
                existing.owner === canonicalInput.owner &&
                existing.peerId === canonicalInput.peerId &&
                existing.registrationNonce === canonicalInput.registrationNonce;
              if (!isExactReplay) {
                return yield* new RegistrationIntentConflict({
                  digest: canonicalInput.digest,
                });
              }
              if (existing.status === "confirmed") {
                return existing;
              }
              const leaseDigest = yield* findLeaseDigest(
                tx,
                canonicalInput.handle
              );
              if (
                activeStatuses.includes(existing.status) &&
                leaseDigest === canonicalInput.digest
              ) {
                if (
                  existing.status === "pending_owner_signature" &&
                  existing.deadline < nowSeconds
                ) {
                  return yield* new RegistrationIntentExpired({
                    digest: canonicalInput.digest,
                  });
                }
                return existing;
              }
              return yield* new RegistrationIntentConflict({
                digest: canonicalInput.digest,
              });
            }

            if (canonicalInput.deadline <= nowSeconds) {
              return yield* new RegistrationIntentExpired({
                digest: canonicalInput.digest,
              });
            }

            const expiredIncumbents = yield* tx
              .select({ digest: registrationHandleLeases.intentDigest })
              .from(registrationHandleLeases)
              .innerJoin(
                registrationIntents,
                eq(
                  registrationIntents.digest,
                  registrationHandleLeases.intentDigest
                )
              )
              .where(
                and(
                  eq(registrationHandleLeases.handle, canonicalInput.handle),
                  eq(registrationIntents.status, "pending_owner_signature"),
                  lt(registrationIntents.deadline, nowSeconds)
                )
              )
              .limit(1)
              .for("update");
            const expiredDigest = expiredIncumbents.at(0)?.digest;
            if (expiredDigest) {
              yield* tx
                .update(registrationIntents)
                .set({ status: "expired", updatedAt: nowDate })
                .where(
                  and(
                    eq(registrationIntents.digest, expiredDigest),
                    eq(registrationIntents.status, "pending_owner_signature"),
                    lt(registrationIntents.deadline, nowSeconds)
                  )
                );
              yield* tx
                .delete(registrationHandleLeases)
                .where(
                  and(
                    eq(registrationHandleLeases.intentDigest, expiredDigest),
                    eq(registrationHandleLeases.handle, canonicalInput.handle)
                  )
                );
            }

            const inserted = yield* tx
              .insert(registrationIntents)
              .values({
                deadline: canonicalInput.deadline,
                digest: canonicalInput.digest,
                handle: canonicalInput.handle,
                observeTokenHash: canonicalInput.observeTokenHash,
                owner: canonicalInput.owner,
                peerId: canonicalInput.peerId,
                registrationNonce: canonicalInput.registrationNonce,
                status: "pending_owner_signature",
                updatedAt: nowDate,
              })
              .onConflictDoNothing()
              .returning();
            const intent = inserted.at(0);
            if (!intent) {
              return yield* new RegistrationIntentConflict({
                digest: canonicalInput.digest,
              });
            }

            const lease = yield* tx
              .insert(registrationHandleLeases)
              .values({
                handle: canonicalInput.handle,
                intentDigest: canonicalInput.digest,
                owner: canonicalInput.owner,
                peerId: canonicalInput.peerId,
                updatedAt: nowDate,
              })
              .onConflictDoNothing()
              .returning({ handle: registrationHandleLeases.handle });
            if (lease.length !== 1) {
              return yield* new HandleLeaseConflict({
                handle: canonicalInput.handle,
              });
            }
            return intent;
          })
        );
      });

      const authorize = Effect.fn("RegistrationStore.authorize")(function* (
        digest: Hash,
        authorization: RegistrationAuthorization
      ) {
        const canonicalDigest = yield* normalizeRegistrationDigest(digest);
        const canonicalAuthorization =
          yield* normalizeRegistrationAuthorization(authorization);
        const now = yield* DateTime.now;
        const nowSeconds = epochSeconds(now);
        const updated = yield* db
          .update(registrationIntents)
          .set({
            ownerSignature: canonicalAuthorization.ownerSignature,
            registrationSignature: canonicalAuthorization.registrationSignature,
            status: "ready",
            updatedAt: DateTime.toDateUtc(now),
          })
          .where(
            and(
              eq(registrationIntents.digest, canonicalDigest),
              eq(registrationIntents.status, "pending_owner_signature"),
              gte(registrationIntents.deadline, nowSeconds)
            )
          )
          .returning();
        const intent = updated.at(0);
        if (intent) {
          return intent;
        }
        const current = yield* find(db, canonicalDigest);
        if (
          current &&
          current.ownerSignature === canonicalAuthorization.ownerSignature &&
          current.registrationSignature ===
            canonicalAuthorization.registrationSignature &&
          ["confirmed", "ready", "submitted"].includes(current.status)
        ) {
          return current;
        }
        return yield* db.transaction((tx) =>
          transitionFailure(
            tx,
            canonicalDigest,
            registrationTransitionSources.authorize,
            nowSeconds
          )
        );
      });

      const markSubmitted = Effect.fn("RegistrationStore.markSubmitted")(
        function* (digest: Hash, transactionHash: Hash) {
          const canonicalDigest = yield* normalizeRegistrationDigest(digest);
          const canonicalTransactionHash =
            yield* normalizeTransactionHash(transactionHash);
          const now = yield* DateTime.now;
          const updated = yield* db
            .update(registrationIntents)
            .set({
              status: "submitted",
              submittedAt: DateTime.toDateUtc(now),
              transactionHash: canonicalTransactionHash,
              updatedAt: DateTime.toDateUtc(now),
            })
            .where(
              and(
                eq(registrationIntents.digest, canonicalDigest),
                eq(registrationIntents.status, "ready")
              )
            )
            .returning();
          const intent = updated.at(0);
          if (intent) {
            return intent;
          }
          const current = yield* find(db, canonicalDigest);
          if (
            current &&
            current.transactionHash === canonicalTransactionHash &&
            ["confirmed", "submitted"].includes(current.status)
          ) {
            return current;
          }
          return yield* db.transaction((tx) =>
            transitionFailure(
              tx,
              canonicalDigest,
              registrationTransitionSources.submit,
              epochSeconds(now)
            )
          );
        }
      );

      const markConfirmed = Effect.fn("RegistrationStore.markConfirmed")(
        function* (digest: Hash, qid: bigint) {
          const canonicalDigest = yield* normalizeRegistrationDigest(digest);
          const canonicalQid = yield* normalizeRegistrationQid(qid);
          const now = yield* DateTime.now;
          return yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const updated = yield* tx
                .update(registrationIntents)
                .set({
                  confirmedAt: DateTime.toDateUtc(now),
                  qid: canonicalQid,
                  status: "confirmed",
                  updatedAt: DateTime.toDateUtc(now),
                })
                .where(
                  and(
                    eq(registrationIntents.digest, canonicalDigest),
                    inArray(registrationIntents.status, ["ready", "submitted"])
                  )
                )
                .returning();
              let intent = updated.at(0);
              if (!intent) {
                const current = yield* find(tx, canonicalDigest);
                if (
                  current?.status === "confirmed" &&
                  current.qid === canonicalQid
                ) {
                  intent = current;
                } else {
                  return yield* transitionFailure(
                    tx,
                    canonicalDigest,
                    registrationTransitionSources.confirm,
                    epochSeconds(now)
                  );
                }
              }
              yield* tx
                .delete(registrationHandleLeases)
                .where(
                  eq(registrationHandleLeases.intentDigest, canonicalDigest)
                );
              return intent;
            })
          );
        }
      );

      const markFailed = Effect.fn("RegistrationStore.markFailed")(function* (
        digest: Hash,
        failureCode: string
      ) {
        const canonicalDigest = yield* normalizeRegistrationDigest(digest);
        const now = yield* DateTime.now;
        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const updated = yield* tx
              .update(registrationIntents)
              .set({
                failureCode,
                status: "failed",
                updatedAt: DateTime.toDateUtc(now),
              })
              .where(
                and(
                  eq(registrationIntents.digest, canonicalDigest),
                  inArray(registrationIntents.status, activeStatuses)
                )
              )
              .returning();
            let intent = updated.at(0);
            if (!intent) {
              const current = yield* find(tx, canonicalDigest);
              if (
                current?.status === "failed" &&
                current.failureCode === failureCode
              ) {
                intent = current;
              } else {
                return yield* transitionFailure(
                  tx,
                  canonicalDigest,
                  activeStatuses,
                  epochSeconds(now)
                );
              }
            }
            yield* tx
              .delete(registrationHandleLeases)
              .where(
                eq(registrationHandleLeases.intentDigest, canonicalDigest)
              );
            return intent;
          })
        );
      });

      const expire = Effect.gen(function* () {
        const now = yield* DateTime.now;
        const nowSeconds = epochSeconds(now);
        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const candidates = yield* tx
              .select({ digest: registrationIntents.digest })
              .from(registrationIntents)
              .where(
                and(
                  inArray(registrationIntents.status, expirableStatuses),
                  lt(registrationIntents.deadline, nowSeconds)
                )
              )
              .orderBy(
                asc(registrationIntents.deadline),
                asc(registrationIntents.digest)
              )
              .limit(registrationExpirationBatchSize)
              .for("update", { skipLocked: true });
            const candidateDigests = candidates.map((row) => row.digest);
            if (candidateDigests.length === 0) {
              return 0;
            }
            const expired = yield* tx
              .update(registrationIntents)
              .set({
                status: "expired",
                updatedAt: DateTime.toDateUtc(now),
              })
              .where(
                and(
                  inArray(registrationIntents.digest, candidateDigests),
                  inArray(registrationIntents.status, expirableStatuses),
                  lt(registrationIntents.deadline, nowSeconds)
                )
              )
              .returning({ digest: registrationIntents.digest });
            const expiredDigests = expired.map((row) => row.digest);
            if (expiredDigests.length === 0) {
              return 0;
            }
            yield* tx
              .delete(registrationHandleLeases)
              .where(
                inArray(registrationHandleLeases.intentDigest, expiredDigests)
              );
            return expired.length;
          })
        );
      });

      return RegistrationStore.of({
        authorize,
        create,
        expire,
        get,
        markConfirmed,
        markFailed,
        markSubmitted,
      });
    })
  );
}

export const RegistrationStoreLive = RegistrationStore.layer.pipe(
  Layer.provide(DatabaseLive)
);
