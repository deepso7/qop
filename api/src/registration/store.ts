import { and, eq, inArray, isNull, or, gt } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Context, Data, DateTime, Effect, Layer, Option } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Hash, Hex } from "viem";

import { Database, DatabaseLive } from "../db/database.ts";
import type { DatabaseClient } from "../db/database.ts";
import {
  registrationAdmissionCodes,
  registrationIntents,
  registrationRelayerState,
} from "../db/schema.ts";
import { epochSeconds } from "../time.ts";
import { RegistrationAdmissionUnauthorized } from "./admission.ts";
import {
  normalizeCreateRegistrationIntent,
  normalizeRegistrationDigest,
  normalizeRegistrationQid,
  normalizeSerializedTransaction,
  normalizeTransactionHash,
} from "./inputs.ts";
import type { RegistrationInputError } from "./inputs.ts";
import { registrationTransitionSources } from "./state.ts";
import type {
  CreateRegistrationIntent,
  RegistrationIntentStatus,
} from "./types.ts";

export type StoredRegistrationIntent = InferSelectModel<
  typeof registrationIntents
>;

type TransactionCallback = Parameters<DatabaseClient["transaction"]>[0];
type Transaction = Parameters<TransactionCallback>[0];

const find = (client: DatabaseClient | Transaction, digest: Hash) =>
  client
    .select()
    .from(registrationIntents)
    .where(eq(registrationIntents.digest, digest))
    .limit(1)
    .pipe(Effect.map((rows) => rows.at(0)));

const findForUpdate = (client: Transaction, digest: Hash) =>
  client
    .select()
    .from(registrationIntents)
    .where(eq(registrationIntents.digest, digest))
    .limit(1)
    .for("update")
    .pipe(Effect.map((rows) => rows.at(0)));

const isExactCreateReplay = (
  stored: StoredRegistrationIntent,
  input: CreateRegistrationIntent
) =>
  stored.admissionCodeHash === input.admissionCodeHash &&
  stored.deadline === input.deadline &&
  stored.deviceKey === input.deviceKey &&
  stored.handle === input.handle &&
  stored.owner === input.owner &&
  stored.ownerSignature === input.ownerSignature &&
  stored.registrationNonce === input.registrationNonce &&
  stored.registrationSignature === input.registrationSignature;

export class RegistrationActiveHandleConflict extends Data.TaggedError(
  "RegistrationActiveHandleConflict"
)<{ readonly handle: string }> {}

export class RegistrationActiveOwnerConflict extends Data.TaggedError(
  "RegistrationActiveOwnerConflict"
)<{ readonly owner: string }> {}

export class RegistrationNonceConflict extends Data.TaggedError(
  "RegistrationNonceConflict"
)<{ readonly nonce: Hash }> {}

export class RegistrationIntentConflict extends Data.TaggedError(
  "RegistrationIntentConflict"
)<{ readonly digest: Hash }> {}

export class RegistrationIntentNotFound extends Data.TaggedError(
  "RegistrationIntentNotFound"
)<{ readonly digest: Hash }> {}

export class RegistrationTransitionConflict extends Data.TaggedError(
  "RegistrationTransitionConflict"
)<{
  readonly actual: RegistrationIntentStatus;
  readonly digest: Hash;
  readonly expected: readonly RegistrationIntentStatus[];
}> {}

export type RegistrationStorePersistenceError =
  | EffectDrizzleQueryError
  | SqlError;

export type RegistrationStoreError =
  | RegistrationActiveHandleConflict
  | RegistrationActiveOwnerConflict
  | RegistrationAdmissionUnauthorized
  | RegistrationInputError
  | RegistrationIntentConflict
  | RegistrationIntentNotFound
  | RegistrationNonceConflict
  | RegistrationStorePersistenceError
  | RegistrationTransitionConflict;

export interface RegistrationSubmission {
  readonly serializedTransaction: Hex;
  readonly transactionHash: Hash;
}

export interface RegistrationStoreContract {
  readonly create: (
    input: CreateRegistrationIntent
  ) => Effect.Effect<StoredRegistrationIntent, RegistrationStoreError>;
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
    failureCode: string,
    expectedStatuses?: readonly RegistrationIntentStatus[]
  ) => Effect.Effect<StoredRegistrationIntent, RegistrationStoreError>;
  readonly prepareSubmission: <Error>(
    digest: Hash,
    pendingNonce: Effect.Effect<bigint, Error>,
    prepare: (nonce: bigint) => Effect.Effect<RegistrationSubmission, Error>
  ) => Effect.Effect<StoredRegistrationIntent, RegistrationStoreError | Error>;
}

const activeStatuses: readonly RegistrationIntentStatus[] =
  registrationTransitionSources.fail;

export class RegistrationStore extends Context.Service<
  RegistrationStore,
  RegistrationStoreContract
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
        expected: readonly RegistrationIntentStatus[]
      ): Effect.fn.Return<never, RegistrationStoreError> {
        const current = yield* find(tx, digest);
        if (!current) {
          return yield* new RegistrationIntentNotFound({ digest });
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
        const canonical = yield* normalizeCreateRegistrationIntent(input);

        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const replay = yield* find(tx, canonical.digest);
            if (replay) {
              if (isExactCreateReplay(replay, canonical)) {
                return replay;
              }
              return yield* new RegistrationIntentConflict({
                digest: canonical.digest,
              });
            }

            const admission = yield* tx
              .select()
              .from(registrationAdmissionCodes)
              .where(
                eq(
                  registrationAdmissionCodes.codeHash,
                  canonical.admissionCodeHash
                )
              )
              .limit(1)
              .for("update")
              .pipe(Effect.map((rows) => rows.at(0)));
            const now = yield* DateTime.now;
            const nowSeconds = epochSeconds(now);
            const nowDate = DateTime.toDateUtc(now);
            if (
              !admission ||
              admission.consumedAt !== null ||
              (admission.expiresAt !== null &&
                admission.expiresAt <= nowSeconds) ||
              (admission.claimedByDigest !== null &&
                admission.claimedByDigest !== canonical.digest)
            ) {
              return yield* new RegistrationAdmissionUnauthorized({
                codeHash: canonical.admissionCodeHash,
              });
            }

            if (admission.claimedByDigest === null) {
              const claimed = yield* tx
                .update(registrationAdmissionCodes)
                .set({ claimedAt: nowDate, claimedByDigest: canonical.digest })
                .where(
                  and(
                    eq(
                      registrationAdmissionCodes.codeHash,
                      canonical.admissionCodeHash
                    ),
                    isNull(registrationAdmissionCodes.claimedByDigest),
                    isNull(registrationAdmissionCodes.consumedAt),
                    or(
                      isNull(registrationAdmissionCodes.expiresAt),
                      gt(registrationAdmissionCodes.expiresAt, nowSeconds)
                    )
                  )
                )
                .returning({ codeHash: registrationAdmissionCodes.codeHash });
              if (claimed.length === 0) {
                return yield* new RegistrationAdmissionUnauthorized({
                  codeHash: canonical.admissionCodeHash,
                });
              }
            }

            const inserted = yield* tx
              .insert(registrationIntents)
              .values({ ...canonical, status: "ready", updatedAt: nowDate })
              .onConflictDoNothing()
              .returning();
            const created = inserted.at(0);
            if (created) {
              return created;
            }

            const concurrentReplay = yield* find(tx, canonical.digest);
            if (
              concurrentReplay &&
              isExactCreateReplay(concurrentReplay, canonical)
            ) {
              return concurrentReplay;
            }
            const [handleConflict] = yield* tx
              .select({ digest: registrationIntents.digest })
              .from(registrationIntents)
              .where(
                and(
                  eq(registrationIntents.handle, canonical.handle),
                  inArray(registrationIntents.status, activeStatuses)
                )
              )
              .limit(1);
            if (handleConflict) {
              return yield* new RegistrationActiveHandleConflict({
                handle: canonical.handle,
              });
            }
            const [ownerConflict] = yield* tx
              .select({ digest: registrationIntents.digest })
              .from(registrationIntents)
              .where(
                and(
                  eq(registrationIntents.owner, canonical.owner),
                  inArray(registrationIntents.status, activeStatuses)
                )
              )
              .limit(1);
            if (ownerConflict) {
              return yield* new RegistrationActiveOwnerConflict({
                owner: canonical.owner,
              });
            }
            return yield* new RegistrationNonceConflict({
              nonce: canonical.registrationNonce,
            });
          })
        );
      });

      const prepareSubmission: RegistrationStoreContract["prepareSubmission"] =
        Effect.fn("RegistrationStore.prepareSubmission")(
          function* (digest, pendingNonce, prepare) {
            const canonicalDigest = yield* normalizeRegistrationDigest(digest);
            return yield* db.transaction((tx) =>
              Effect.gen(function* () {
                yield* tx
                  .insert(registrationRelayerState)
                  .values({ id: 1, nextNonce: 0n })
                  .onConflictDoNothing();
                const relayerState = yield* tx
                  .select()
                  .from(registrationRelayerState)
                  .where(eq(registrationRelayerState.id, 1))
                  .for("update")
                  .pipe(Effect.map((rows) => rows.at(0)));
                if (!relayerState) {
                  return yield* new RegistrationIntentNotFound({
                    digest: canonicalDigest,
                  });
                }

                const current = yield* findForUpdate(tx, canonicalDigest);
                if (
                  current &&
                  ["confirmed", "submitted"].includes(current.status)
                ) {
                  return current;
                }
                if (current?.status !== "ready") {
                  return yield* transitionFailure(
                    tx,
                    canonicalDigest,
                    registrationTransitionSources.submit
                  );
                }

                const chainNonce = yield* pendingNonce;
                const nonce =
                  chainNonce > relayerState.nextNonce
                    ? chainNonce
                    : relayerState.nextNonce;
                const submission = yield* prepare(nonce);
                const transactionHash = yield* normalizeTransactionHash(
                  submission.transactionHash
                );
                const serializedTransaction =
                  yield* normalizeSerializedTransaction(
                    submission.serializedTransaction
                  );
                const submittedAt = DateTime.toDateUtc(yield* DateTime.now);
                yield* tx
                  .update(registrationRelayerState)
                  .set({ nextNonce: nonce + 1n })
                  .where(eq(registrationRelayerState.id, 1));
                const updated = yield* tx
                  .update(registrationIntents)
                  .set({
                    serializedTransaction,
                    status: "submitted",
                    submittedAt,
                    transactionHash,
                    updatedAt: submittedAt,
                  })
                  .where(
                    and(
                      eq(registrationIntents.digest, canonicalDigest),
                      eq(registrationIntents.status, "ready")
                    )
                  )
                  .returning();
                return (
                  updated[0] ??
                  (yield* transitionFailure(
                    tx,
                    canonicalDigest,
                    registrationTransitionSources.submit
                  ))
                );
              })
            );
          }
        );

      const markConfirmed = Effect.fn("RegistrationStore.markConfirmed")(
        function* (digest: Hash, qid: bigint) {
          const canonicalDigest = yield* normalizeRegistrationDigest(digest);
          const canonicalQid = yield* normalizeRegistrationQid(qid);
          const now = DateTime.toDateUtc(yield* DateTime.now);
          return yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const updated = yield* tx
                .update(registrationIntents)
                .set({
                  confirmedAt: now,
                  qid: canonicalQid,
                  status: "confirmed",
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(registrationIntents.digest, canonicalDigest),
                    inArray(registrationIntents.status, ["ready", "submitted"])
                  )
                )
                .returning();
              const confirmed = updated.at(0);
              if (!confirmed) {
                const current = yield* find(tx, canonicalDigest);
                if (
                  current?.status === "confirmed" &&
                  current.qid === canonicalQid
                ) {
                  return current;
                }
                return yield* transitionFailure(
                  tx,
                  canonicalDigest,
                  registrationTransitionSources.confirm
                );
              }
              yield* tx
                .update(registrationAdmissionCodes)
                .set({ consumedAt: now })
                .where(
                  and(
                    eq(
                      registrationAdmissionCodes.codeHash,
                      confirmed.admissionCodeHash
                    ),
                    eq(
                      registrationAdmissionCodes.claimedByDigest,
                      canonicalDigest
                    ),
                    isNull(registrationAdmissionCodes.consumedAt)
                  )
                );
              return confirmed;
            })
          );
        }
      );

      const markFailed = Effect.fn("RegistrationStore.markFailed")(function* (
        digest: Hash,
        failureCode: string,
        expectedStatuses: readonly RegistrationIntentStatus[] = activeStatuses
      ) {
        const canonicalDigest = yield* normalizeRegistrationDigest(digest);
        const now = DateTime.toDateUtc(yield* DateTime.now);
        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const updated = yield* tx
              .update(registrationIntents)
              .set({ failureCode, status: "failed", updatedAt: now })
              .where(
                and(
                  eq(registrationIntents.digest, canonicalDigest),
                  inArray(registrationIntents.status, expectedStatuses)
                )
              )
              .returning();
            const failed = updated.at(0);
            if (failed) {
              yield* tx
                .update(registrationAdmissionCodes)
                .set({ claimedAt: null, claimedByDigest: null })
                .where(
                  and(
                    eq(
                      registrationAdmissionCodes.codeHash,
                      failed.admissionCodeHash
                    ),
                    eq(
                      registrationAdmissionCodes.claimedByDigest,
                      canonicalDigest
                    ),
                    isNull(registrationAdmissionCodes.consumedAt)
                  )
                );
              return failed;
            }
            const current = yield* find(tx, canonicalDigest);
            if (
              current?.status === "failed" &&
              current.failureCode === failureCode
            ) {
              return current;
            }
            return yield* transitionFailure(
              tx,
              canonicalDigest,
              expectedStatuses
            );
          })
        );
      });

      return RegistrationStore.of({
        create,
        get,
        markConfirmed,
        markFailed,
        prepareSubmission,
      });
    })
  );
}

export const RegistrationStoreLive = RegistrationStore.layer.pipe(
  Layer.provide(DatabaseLive)
);
