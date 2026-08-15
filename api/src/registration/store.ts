import { and, asc, eq, gt, gte, inArray, isNull, lt, or } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Context, Data, DateTime, Effect, Layer, Option } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Hash, Hex } from "viem";

import { Database, DatabaseLive } from "../db/database.ts";
import type { DatabaseClient } from "../db/database.ts";
import {
  registrationAdmissionCodes,
  registrationHandleLeases,
  registrationIntents,
  registrationRelayerState,
} from "../db/schema.ts";
import { epochSeconds } from "../time.ts";
import { RegistrationAdmissionUnauthorized } from "./admission.ts";
import {
  normalizeCreateRegistrationIntent,
  normalizeRegistrationAuthorization,
  normalizeRegistrationDigest,
  normalizeRegistrationIdempotencyKeyHash,
  normalizeRegistrationObserveTokenHash,
  normalizeRegistrationOwnerSignature,
  normalizeRegistrationQid,
  normalizeSerializedTransaction,
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

const findForUpdate = (
  client: Transaction,
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
    .for("update")
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

const findByObserveTokenHash = (
  client: DatabaseClient | Transaction,
  observeTokenHash: Hash
): Effect.Effect<
  StoredRegistrationIntent | undefined,
  RegistrationStorePersistenceError
> =>
  client
    .select()
    .from(registrationIntents)
    .where(eq(registrationIntents.observeTokenHash, observeTokenHash))
    .limit(1)
    .pipe(Effect.map((rows) => rows.at(0)));

const findByIdempotencyKeyHash = (
  client: DatabaseClient | Transaction,
  idempotencyKeyHash: Hash
): Effect.Effect<
  StoredRegistrationIntent | undefined,
  RegistrationStorePersistenceError
> =>
  client
    .select()
    .from(registrationIntents)
    .where(eq(registrationIntents.idempotencyKeyHash, idempotencyKeyHash))
    .limit(1)
    .pipe(Effect.map((rows) => rows.at(0)));

const isExactCreateReplay = (
  stored: StoredRegistrationIntent,
  input: CreateRegistrationIntent
): boolean =>
  stored.admissionCodeHash === input.admissionCodeHash &&
  stored.deadline === input.deadline &&
  stored.deviceCommitment === input.deviceCommitment &&
  stored.handle === input.handle &&
  stored.idempotencyKeyHash === input.idempotencyKeyHash &&
  stored.observeTokenHash === input.observeTokenHash &&
  stored.owner === input.owner &&
  stored.peerId === input.peerId &&
  stored.registrationNonce === input.registrationNonce;

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
  readonly actual: RegistrationIntentStatus;
  readonly digest: string;
  readonly expected: readonly RegistrationIntentStatus[];
}> {}

export class RegistrationDraftLimitReached extends Data.TaggedError(
  "RegistrationDraftLimitReached"
)<{ readonly handle: string; readonly limit: number }> {}

export class RegistrationAdmissionDraftLimitReached extends Data.TaggedError(
  "RegistrationAdmissionDraftLimitReached"
)<{ readonly codeHash: Hash; readonly limit: number }> {}

export type RegistrationStorePersistenceError =
  | EffectDrizzleQueryError
  | SqlError;

export type RegistrationStoreError =
  | HandleLeaseConflict
  | RegistrationAdmissionDraftLimitReached
  | RegistrationAdmissionUnauthorized
  | RegistrationDraftLimitReached
  | RegistrationInputError
  | RegistrationIntentConflict
  | RegistrationIntentExpired
  | RegistrationIntentNotFound
  | RegistrationStorePersistenceError
  | RegistrationTransitionConflict;

export interface RegistrationSubmission {
  readonly serializedTransaction: Hex;
  readonly transactionHash: Hash;
}

export interface RegistrationStoreShape {
  readonly releaseAuthorizationReservation: (
    digest: Hash
  ) => Effect.Effect<
    void,
    RegistrationInputError | RegistrationStorePersistenceError
  >;
  readonly reserveAuthorization: (
    digest: Hash,
    ownerSignature: Hex
  ) => Effect.Effect<StoredRegistrationIntent, RegistrationStoreError>;
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
  readonly getByObserveTokenHash: (
    observeTokenHash: Hash
  ) => Effect.Effect<
    Option.Option<StoredRegistrationIntent>,
    RegistrationInputError | RegistrationStorePersistenceError
  >;
  readonly getByIdempotencyKeyHash: (
    idempotencyKeyHash: Hash
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
  readonly prepareSubmission: <E>(
    digest: Hash,
    pendingNonce: Effect.Effect<bigint, E>,
    prepare: (nonce: bigint) => Effect.Effect<RegistrationSubmission, E>
  ) => Effect.Effect<StoredRegistrationIntent, RegistrationStoreError | E>;
}

const activeStatuses: readonly RegistrationIntentStatus[] =
  registrationTransitionSources.fail;
const expirableStatuses: readonly RegistrationIntentStatus[] =
  registrationTransitionSources.expire;

export const registrationExpirationBatchSize = 100;
export const registrationDraftLimitPerHandle = 8;
export const registrationDraftLimitPerAdmission = 8;

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

      const getByObserveTokenHash = Effect.fn(
        "RegistrationStore.getByObserveTokenHash"
      )(function* (observeTokenHash: Hash) {
        const canonicalHash =
          yield* normalizeRegistrationObserveTokenHash(observeTokenHash);
        return Option.fromUndefinedOr(
          yield* findByObserveTokenHash(db, canonicalHash)
        );
      });

      const getByIdempotencyKeyHash = Effect.fn(
        "RegistrationStore.getByIdempotencyKeyHash"
      )(function* (idempotencyKeyHash: Hash) {
        const canonicalHash =
          yield* normalizeRegistrationIdempotencyKeyHash(idempotencyKeyHash);
        return Option.fromUndefinedOr(
          yield* findByIdempotencyKeyHash(db, canonicalHash)
        );
      });

      const acquireHandleLease = Effect.fn(
        "RegistrationStore.acquireHandleLease"
      )(function* (
        tx: Transaction,
        current: StoredRegistrationIntent,
        updatedAt: Date
      ) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const inserted = yield* tx
            .insert(registrationHandleLeases)
            .values({
              handle: current.handle,
              intentDigest: current.digest,
              owner: current.owner,
              peerId: current.peerId,
              updatedAt,
            })
            .onConflictDoNothing()
            .returning({ handle: registrationHandleLeases.handle });
          if (inserted.length === 1) {
            return;
          }
          const incumbent = yield* findLeaseDigest(tx, current.handle);
          if (incumbent === current.digest) {
            return;
          }
          if (incumbent !== undefined) {
            return yield* new HandleLeaseConflict({
              handle: current.handle,
            });
          }
        }
        return yield* new HandleLeaseConflict({ handle: current.handle });
      });

      const reserveAuthorization = Effect.fn(
        "RegistrationStore.reserveAuthorization"
      )(function* (digest: Hash, ownerSignature: Hex) {
        const canonicalDigest = yield* normalizeRegistrationDigest(digest);
        const canonicalOwnerSignature =
          yield* normalizeRegistrationOwnerSignature(ownerSignature);
        const now = yield* DateTime.now;
        const nowSeconds = epochSeconds(now);
        const updatedAt = DateTime.toDateUtc(now);
        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* findForUpdate(tx, canonicalDigest);
            if (!current) {
              return yield* new RegistrationIntentNotFound({
                digest: canonicalDigest,
              });
            }
            if (
              current.ownerSignature === canonicalOwnerSignature &&
              ["confirmed", "ready", "submitted"].includes(current.status)
            ) {
              return current;
            }
            if (
              current.status === "pending_owner_signature" &&
              current.deadline < nowSeconds
            ) {
              return yield* new RegistrationIntentExpired({
                digest: canonicalDigest,
              });
            }
            if (current.status !== "pending_owner_signature") {
              return yield* new RegistrationTransitionConflict({
                actual: current.status,
                digest: canonicalDigest,
                expected: registrationTransitionSources.authorize,
              });
            }
            if (
              current.ownerSignature !== null &&
              current.ownerSignature !== canonicalOwnerSignature
            ) {
              return yield* new RegistrationIntentConflict({
                digest: canonicalDigest,
              });
            }
            const admissionRows = yield* tx
              .select()
              .from(registrationAdmissionCodes)
              .where(
                eq(
                  registrationAdmissionCodes.codeHash,
                  current.admissionCodeHash
                )
              )
              .limit(1)
              .for("update");
            const admission = admissionRows.at(0);
            if (
              !admission ||
              admission.consumedAt !== null ||
              (admission.expiresAt !== null &&
                admission.expiresAt <= nowSeconds) ||
              (admission.claimedByDigest !== null &&
                admission.claimedByDigest !== canonicalDigest)
            ) {
              return yield* new RegistrationAdmissionUnauthorized({
                codeHash: current.admissionCodeHash,
              });
            }
            if (admission.claimedByDigest === null) {
              yield* tx
                .update(registrationAdmissionCodes)
                .set({
                  claimedAt: updatedAt,
                  claimedByDigest: canonicalDigest,
                })
                .where(
                  and(
                    eq(
                      registrationAdmissionCodes.codeHash,
                      current.admissionCodeHash
                    ),
                    isNull(registrationAdmissionCodes.claimedByDigest),
                    isNull(registrationAdmissionCodes.consumedAt),
                    or(
                      isNull(registrationAdmissionCodes.expiresAt),
                      gt(registrationAdmissionCodes.expiresAt, nowSeconds)
                    )
                  )
                );
            }
            yield* acquireHandleLease(tx, current, updatedAt);
            const rows = yield* tx
              .update(registrationIntents)
              .set({
                draftSlot: null,
                ownerSignature: canonicalOwnerSignature,
                updatedAt,
              })
              .where(eq(registrationIntents.digest, canonicalDigest))
              .returning();
            return rows[0] as StoredRegistrationIntent;
          })
        );
      });

      const releaseAuthorizationReservation = Effect.fn(
        "RegistrationStore.releaseAuthorizationReservation"
      )(function* (digest: Hash) {
        const canonicalDigest = yield* normalizeRegistrationDigest(digest);
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* findForUpdate(tx, canonicalDigest);
            if (
              !current ||
              current.status !== "pending_owner_signature" ||
              current.registrationSignature !== null
            ) {
              return;
            }
            yield* tx
              .delete(registrationHandleLeases)
              .where(
                eq(registrationHandleLeases.intentDigest, canonicalDigest)
              );
            yield* tx
              .update(registrationAdmissionCodes)
              .set({ claimedAt: null, claimedByDigest: null })
              .where(
                and(
                  eq(
                    registrationAdmissionCodes.codeHash,
                    current.admissionCodeHash
                  ),
                  eq(
                    registrationAdmissionCodes.claimedByDigest,
                    canonicalDigest
                  ),
                  isNull(registrationAdmissionCodes.consumedAt)
                )
              );
          })
        );
      });

      const findPrepareReplay = Effect.fn(
        "RegistrationStore.findPrepareReplay"
      )(function* (
        tx: Transaction,
        input: CreateRegistrationIntent,
        nowSeconds: bigint
      ) {
        const replay = yield* findByIdempotencyKeyHash(
          tx,
          input.idempotencyKeyHash
        );
        if (!replay) {
          return;
        }
        if (
          replay.handle !== input.handle ||
          replay.admissionCodeHash !== input.admissionCodeHash ||
          replay.deviceCommitment !== input.deviceCommitment ||
          replay.observeTokenHash !== input.observeTokenHash ||
          replay.owner !== input.owner ||
          replay.peerId !== input.peerId
        ) {
          return yield* new RegistrationIntentConflict({
            digest: replay.digest,
          });
        }
        if (
          replay.status === "pending_owner_signature" &&
          replay.deadline < nowSeconds
        ) {
          return yield* new RegistrationIntentExpired({
            digest: replay.digest,
          });
        }
        if (replay.status === "pending_owner_signature") {
          return replay;
        }
        return yield* new RegistrationIntentConflict({
          digest: replay.digest,
        });
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
              if (!isExactCreateReplay(existing, canonicalInput)) {
                return yield* new RegistrationIntentConflict({
                  digest: canonicalInput.digest,
                });
              }
              if (existing.status === "confirmed") {
                return existing;
              }
              if (activeStatuses.includes(existing.status)) {
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

            const admissionRows = yield* tx
              .select()
              .from(registrationAdmissionCodes)
              .where(
                eq(
                  registrationAdmissionCodes.codeHash,
                  canonicalInput.admissionCodeHash
                )
              )
              .limit(1)
              .for("update");
            const admission = admissionRows.at(0);
            if (
              !admission ||
              admission.consumedAt !== null ||
              (admission.expiresAt !== null &&
                admission.expiresAt <= nowSeconds)
            ) {
              return yield* new RegistrationAdmissionUnauthorized({
                codeHash: canonicalInput.admissionCodeHash,
              });
            }

            const idempotentReplay = yield* findPrepareReplay(
              tx,
              canonicalInput,
              nowSeconds
            );
            if (idempotentReplay) {
              return idempotentReplay;
            }

            const admissionDrafts = yield* tx
              .select({ digest: registrationIntents.digest })
              .from(registrationIntents)
              .where(
                and(
                  eq(
                    registrationIntents.admissionCodeHash,
                    canonicalInput.admissionCodeHash
                  ),
                  eq(registrationIntents.status, "pending_owner_signature")
                )
              )
              .limit(registrationDraftLimitPerAdmission);
            if (admissionDrafts.length >= registrationDraftLimitPerAdmission) {
              return yield* new RegistrationAdmissionDraftLimitReached({
                codeHash: canonicalInput.admissionCodeHash,
                limit: registrationDraftLimitPerAdmission,
              });
            }

            if (canonicalInput.deadline <= nowSeconds) {
              return yield* new RegistrationIntentExpired({
                digest: canonicalInput.digest,
              });
            }

            let intent: StoredRegistrationIntent | undefined;
            for (
              let draftSlot = 0;
              draftSlot < registrationDraftLimitPerHandle;
              draftSlot += 1
            ) {
              const inserted = yield* tx
                .insert(registrationIntents)
                .values({
                  admissionCodeHash: canonicalInput.admissionCodeHash,
                  deadline: canonicalInput.deadline,
                  deviceCommitment: canonicalInput.deviceCommitment,
                  digest: canonicalInput.digest,
                  draftSlot,
                  handle: canonicalInput.handle,
                  idempotencyKeyHash: canonicalInput.idempotencyKeyHash,
                  observeTokenHash: canonicalInput.observeTokenHash,
                  owner: canonicalInput.owner,
                  peerId: canonicalInput.peerId,
                  registrationNonce: canonicalInput.registrationNonce,
                  status: "pending_owner_signature",
                  updatedAt: nowDate,
                })
                .onConflictDoNothing()
                .returning();
              intent = inserted.at(0);
              if (intent) {
                break;
              }
            }
            if (!intent) {
              const concurrentReplay = yield* findPrepareReplay(
                tx,
                canonicalInput,
                nowSeconds
              );
              if (concurrentReplay) {
                return concurrentReplay;
              }
              if (yield* find(tx, canonicalInput.digest)) {
                return yield* new RegistrationIntentConflict({
                  digest: canonicalInput.digest,
                });
              }
              const capabilityOwner = yield* findByObserveTokenHash(
                tx,
                canonicalInput.observeTokenHash
              );
              if (capabilityOwner) {
                return yield* new RegistrationIntentConflict({
                  digest: capabilityOwner.digest,
                });
              }
              return yield* new RegistrationDraftLimitReached({
                handle: canonicalInput.handle,
                limit: registrationDraftLimitPerHandle,
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
        yield* reserveAuthorization(
          canonicalDigest,
          canonicalAuthorization.ownerSignature
        );
        const now = yield* DateTime.now;
        const nowSeconds = epochSeconds(now);
        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* findForUpdate(tx, canonicalDigest);
            if (
              current &&
              current.ownerSignature ===
                canonicalAuthorization.ownerSignature &&
              current.registrationSignature ===
                canonicalAuthorization.registrationSignature &&
              ["confirmed", "ready", "submitted"].includes(current.status)
            ) {
              return current;
            }
            if (!current) {
              return yield* new RegistrationIntentNotFound({
                digest: canonicalDigest,
              });
            }
            if (
              current.status === "pending_owner_signature" &&
              current.deadline < nowSeconds
            ) {
              return yield* new RegistrationIntentExpired({
                digest: canonicalDigest,
              });
            }
            if (current.status !== "pending_owner_signature") {
              return yield* new RegistrationTransitionConflict({
                actual: current.status,
                digest: canonicalDigest,
                expected: registrationTransitionSources.authorize,
              });
            }

            const admissionRows = yield* tx
              .select()
              .from(registrationAdmissionCodes)
              .where(
                eq(
                  registrationAdmissionCodes.codeHash,
                  current.admissionCodeHash
                )
              )
              .limit(1)
              .for("update");
            const admission = admissionRows.at(0);
            if (
              !admission ||
              admission.claimedByDigest !== canonicalDigest ||
              admission.consumedAt !== null
            ) {
              return yield* new RegistrationAdmissionUnauthorized({
                codeHash: current.admissionCodeHash,
              });
            }

            yield* acquireHandleLease(tx, current, DateTime.toDateUtc(now));

            const updated = yield* tx
              .update(registrationIntents)
              .set({
                draftSlot: null,
                ownerSignature: canonicalAuthorization.ownerSignature,
                registrationSignature:
                  canonicalAuthorization.registrationSignature,
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
            const authorized = updated.at(0);
            if (authorized) {
              yield* tx
                .update(registrationAdmissionCodes)
                .set({ consumedAt: DateTime.toDateUtc(now) })
                .where(
                  and(
                    eq(
                      registrationAdmissionCodes.codeHash,
                      current.admissionCodeHash
                    ),
                    eq(
                      registrationAdmissionCodes.claimedByDigest,
                      canonicalDigest
                    ),
                    isNull(registrationAdmissionCodes.consumedAt)
                  )
                );
              return authorized;
            }
            const replay = yield* find(tx, canonicalDigest);
            if (
              replay?.ownerSignature ===
                canonicalAuthorization.ownerSignature &&
              replay.registrationSignature ===
                canonicalAuthorization.registrationSignature &&
              ["confirmed", "ready", "submitted"].includes(replay.status)
            ) {
              return replay;
            }
            return yield* transitionFailure(
              tx,
              canonicalDigest,
              registrationTransitionSources.authorize,
              nowSeconds
            );
          })
        );
      });

      const prepareSubmission: RegistrationStoreShape["prepareSubmission"] =
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
                  .pipe(Effect.map((rows) => rows[0]));
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
                  const now = yield* DateTime.now;
                  return yield* transitionFailure(
                    tx,
                    canonicalDigest,
                    registrationTransitionSources.submit,
                    epochSeconds(now)
                  );
                }

                const chainNonce = yield* pendingNonce;
                const nonce =
                  chainNonce > relayerState.nextNonce
                    ? chainNonce
                    : relayerState.nextNonce;
                const submission = yield* prepare(nonce);
                const canonicalTransactionHash =
                  yield* normalizeTransactionHash(submission.transactionHash);
                const canonicalSerializedTransaction =
                  yield* normalizeSerializedTransaction(
                    submission.serializedTransaction
                  );
                const now = yield* DateTime.now;
                yield* tx
                  .update(registrationRelayerState)
                  .set({ nextNonce: nonce + 1n })
                  .where(eq(registrationRelayerState.id, 1));
                const updated = yield* tx
                  .update(registrationIntents)
                  .set({
                    serializedTransaction: canonicalSerializedTransaction,
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
                return (
                  updated[0] ??
                  (yield* transitionFailure(
                    tx,
                    canonicalDigest,
                    registrationTransitionSources.submit,
                    epochSeconds(now)
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
        failureCode: string,
        expectedStatuses: readonly RegistrationIntentStatus[] = activeStatuses
      ) {
        const canonicalDigest = yield* normalizeRegistrationDigest(digest);
        const now = yield* DateTime.now;
        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const updated = yield* tx
              .update(registrationIntents)
              .set({
                draftSlot: null,
                failureCode,
                status: "failed",
                updatedAt: DateTime.toDateUtc(now),
              })
              .where(
                and(
                  eq(registrationIntents.digest, canonicalDigest),
                  inArray(registrationIntents.status, expectedStatuses)
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
                  expectedStatuses,
                  epochSeconds(now)
                );
              }
            }
            yield* tx
              .delete(registrationHandleLeases)
              .where(
                eq(registrationHandleLeases.intentDigest, canonicalDigest)
              );
            yield* tx
              .update(registrationAdmissionCodes)
              .set({ claimedAt: null, claimedByDigest: null })
              .where(
                and(
                  eq(
                    registrationAdmissionCodes.claimedByDigest,
                    canonicalDigest
                  ),
                  isNull(registrationAdmissionCodes.consumedAt)
                )
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
                draftSlot: null,
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
            yield* tx
              .update(registrationAdmissionCodes)
              .set({ claimedAt: null, claimedByDigest: null })
              .where(
                and(
                  inArray(
                    registrationAdmissionCodes.claimedByDigest,
                    expiredDigests
                  ),
                  isNull(registrationAdmissionCodes.consumedAt)
                )
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
        getByIdempotencyKeyHash,
        getByObserveTokenHash,
        markConfirmed,
        markFailed,
        prepareSubmission,
        releaseAuthorizationReservation,
        reserveAuthorization,
      });
    })
  );
}

export const RegistrationStoreLive = RegistrationStore.layer.pipe(
  Layer.provide(DatabaseLive)
);
