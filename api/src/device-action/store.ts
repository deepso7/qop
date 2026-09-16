import { and, eq, inArray } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Context, Data, DateTime, Effect, Layer, Option } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Hash, Hex } from "viem";

import { Database, DatabaseLive } from "../db/database.ts";
import type { DatabaseClient } from "../db/database.ts";
import { deviceActionIntents, registrationRelayerState } from "../db/schema.ts";
import {
  normalizeRegistrationDigest,
  normalizeRegistrationOwner,
  normalizeRegistrationOwnerSignature,
  normalizeSerializedTransaction,
  normalizeTransactionHash,
} from "../registration/inputs.ts";
import type { RegistrationInputError } from "../registration/inputs.ts";
import { deviceActionTransitionSources } from "./state.ts";
import type {
  CreateDeviceActionIntent,
  DeviceActionIntentStatus,
} from "./types.ts";

export type StoredDeviceActionIntent = InferSelectModel<
  typeof deviceActionIntents
>;

type TransactionCallback = Parameters<DatabaseClient["transaction"]>[0];
type Transaction = Parameters<TransactionCallback>[0];

const find = (client: DatabaseClient | Transaction, digest: Hash) =>
  client
    .select()
    .from(deviceActionIntents)
    .where(eq(deviceActionIntents.digest, digest))
    .limit(1)
    .pipe(Effect.map((rows) => rows.at(0)));

const findForUpdate = (client: Transaction, digest: Hash) =>
  client
    .select()
    .from(deviceActionIntents)
    .where(eq(deviceActionIntents.digest, digest))
    .limit(1)
    .for("update")
    .pipe(Effect.map((rows) => rows.at(0)));

const isExactCreateReplay = (
  stored: StoredDeviceActionIntent,
  input: CreateDeviceActionIntent
) =>
  stored.accountNonce === input.accountNonce &&
  stored.deadline === input.deadline &&
  stored.deviceKey === input.deviceKey &&
  stored.operation === input.operation &&
  stored.owner === input.owner &&
  stored.ownerSignature === input.ownerSignature &&
  stored.qid === input.qid;

export class DeviceActionDeadlineInvalid extends Data.TaggedError(
  "DeviceActionDeadlineInvalid"
)<{ readonly deadline: bigint }> {}

export class DeviceActionInFlightConflict extends Data.TaggedError(
  "DeviceActionInFlightConflict"
)<{ readonly digest: Hash; readonly qid: bigint }> {}

export class DeviceActionIntentConflict extends Data.TaggedError(
  "DeviceActionIntentConflict"
)<{ readonly digest: Hash }> {}

export class DeviceActionIntentNotFound extends Data.TaggedError(
  "DeviceActionIntentNotFound"
)<{ readonly digest: Hash }> {}

export class DeviceActionTransitionConflict extends Data.TaggedError(
  "DeviceActionTransitionConflict"
)<{
  readonly actual: DeviceActionIntentStatus;
  readonly digest: Hash;
  readonly expected: readonly DeviceActionIntentStatus[];
}> {}

export type DeviceActionStorePersistenceError =
  | EffectDrizzleQueryError
  | SqlError;

export type DeviceActionStoreError =
  | DeviceActionDeadlineInvalid
  | DeviceActionInFlightConflict
  | DeviceActionIntentConflict
  | DeviceActionIntentNotFound
  | DeviceActionTransitionConflict
  | RegistrationInputError
  | DeviceActionStorePersistenceError;

export interface DeviceActionSubmission {
  readonly serializedTransaction: Hex;
  readonly transactionHash: Hash;
}

export interface DeviceActionStoreContract {
  readonly create: (
    input: CreateDeviceActionIntent
  ) => Effect.Effect<StoredDeviceActionIntent, DeviceActionStoreError>;
  readonly get: (
    digest: Hash
  ) => Effect.Effect<
    Option.Option<StoredDeviceActionIntent>,
    RegistrationInputError | DeviceActionStorePersistenceError
  >;
  readonly markConfirmed: (
    digest: Hash
  ) => Effect.Effect<StoredDeviceActionIntent, DeviceActionStoreError>;
  readonly markTerminal: (
    digest: Hash,
    status: "expired" | "reverted",
    failureCode: string,
    expectedStatuses?: readonly DeviceActionIntentStatus[]
  ) => Effect.Effect<StoredDeviceActionIntent, DeviceActionStoreError>;
  readonly prepareSubmission: <Error>(
    digest: Hash,
    pendingNonce: Effect.Effect<bigint, Error>,
    prepare: (nonce: bigint) => Effect.Effect<DeviceActionSubmission, Error>
  ) => Effect.Effect<StoredDeviceActionIntent, DeviceActionStoreError | Error>;
}

const activeStatuses: readonly DeviceActionIntentStatus[] = [
  "ready",
  "submitted",
];

export class DeviceActionStore extends Context.Service<
  DeviceActionStore,
  DeviceActionStoreContract
>()("@qop/api/DeviceActionStore") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const { client: db } = yield* Database;

      const transitionFailure = Effect.fn(
        "DeviceActionStore.transitionFailure"
      )(function* (
        tx: Transaction,
        digest: Hash,
        expected: readonly DeviceActionIntentStatus[]
      ): Effect.fn.Return<never, DeviceActionStoreError> {
        const current = yield* find(tx, digest);
        if (!current) {
          return yield* new DeviceActionIntentNotFound({ digest });
        }
        return yield* new DeviceActionTransitionConflict({
          actual: current.status,
          digest,
          expected,
        });
      });

      const get = Effect.fn("DeviceActionStore.get")(function* (digest: Hash) {
        const canonicalDigest = yield* normalizeRegistrationDigest(digest);
        return Option.fromUndefinedOr(yield* find(db, canonicalDigest));
      });

      const create = Effect.fn("DeviceActionStore.create")(function* (
        input: CreateDeviceActionIntent
      ) {
        const digest = yield* normalizeRegistrationDigest(input.digest);
        const deviceKey = yield* normalizeRegistrationDigest(input.deviceKey);
        const owner = yield* normalizeRegistrationOwner(input.owner);
        const ownerSignature = yield* normalizeRegistrationOwnerSignature(
          input.ownerSignature
        );
        const canonical: CreateDeviceActionIntent = {
          ...input,
          deviceKey,
          digest,
          owner,
          ownerSignature,
        };

        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const replay = yield* find(tx, canonical.digest);
            if (replay) {
              if (isExactCreateReplay(replay, canonical)) {
                return replay;
              }
              return yield* new DeviceActionIntentConflict({
                digest: canonical.digest,
              });
            }

            const now = yield* DateTime.now;
            const nowDate = DateTime.toDateUtc(now);
            const inserted = yield* tx
              .insert(deviceActionIntents)
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
            const [qidConflict] = yield* tx
              .select({ digest: deviceActionIntents.digest })
              .from(deviceActionIntents)
              .where(
                and(
                  eq(deviceActionIntents.qid, canonical.qid),
                  inArray(deviceActionIntents.status, activeStatuses)
                )
              )
              .limit(1);
            if (qidConflict) {
              return yield* new DeviceActionInFlightConflict({
                digest: qidConflict.digest,
                qid: canonical.qid,
              });
            }
            return yield* new DeviceActionIntentConflict({
              digest: canonical.digest,
            });
          })
        );
      });

      const prepareSubmission: DeviceActionStoreContract["prepareSubmission"] =
        Effect.fn("DeviceActionStore.prepareSubmission")(
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
                  return yield* new DeviceActionIntentNotFound({
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
                    deviceActionTransitionSources.submit
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
                  .update(deviceActionIntents)
                  .set({
                    serializedTransaction,
                    status: "submitted",
                    submittedAt,
                    transactionHash,
                    updatedAt: submittedAt,
                  })
                  .where(
                    and(
                      eq(deviceActionIntents.digest, canonicalDigest),
                      eq(deviceActionIntents.status, "ready")
                    )
                  )
                  .returning();
                return (
                  updated[0] ??
                  (yield* transitionFailure(
                    tx,
                    canonicalDigest,
                    deviceActionTransitionSources.submit
                  ))
                );
              })
            );
          }
        );

      const markConfirmed = Effect.fn("DeviceActionStore.markConfirmed")(
        function* (digest: Hash) {
          const canonicalDigest = yield* normalizeRegistrationDigest(digest);
          const now = DateTime.toDateUtc(yield* DateTime.now);
          return yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const updated = yield* tx
                .update(deviceActionIntents)
                .set({
                  confirmedAt: now,
                  status: "confirmed",
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(deviceActionIntents.digest, canonicalDigest),
                    inArray(deviceActionIntents.status, ["ready", "submitted"])
                  )
                )
                .returning();
              const confirmed = updated.at(0);
              if (confirmed) {
                return confirmed;
              }
              const current = yield* find(tx, canonicalDigest);
              if (current?.status === "confirmed") {
                return current;
              }
              return yield* transitionFailure(
                tx,
                canonicalDigest,
                deviceActionTransitionSources.confirm
              );
            })
          );
        }
      );

      const markTerminal = Effect.fn("DeviceActionStore.markTerminal")(
        function* (
          digest: Hash,
          status: "expired" | "reverted",
          failureCode: string,
          expectedStatuses: readonly DeviceActionIntentStatus[] = status ===
          "expired"
            ? deviceActionTransitionSources.expire
            : deviceActionTransitionSources.revert
        ) {
          const canonicalDigest = yield* normalizeRegistrationDigest(digest);
          const now = DateTime.toDateUtc(yield* DateTime.now);
          return yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const updated = yield* tx
                .update(deviceActionIntents)
                .set({ failureCode, status, updatedAt: now })
                .where(
                  and(
                    eq(deviceActionIntents.digest, canonicalDigest),
                    inArray(deviceActionIntents.status, expectedStatuses)
                  )
                )
                .returning();
              const terminal = updated.at(0);
              if (terminal) {
                return terminal;
              }
              const current = yield* find(tx, canonicalDigest);
              if (
                current?.status === status &&
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
        }
      );

      return DeviceActionStore.of({
        create,
        get,
        markConfirmed,
        markTerminal,
        prepareSubmission,
      });
    })
  );
}

export const DeviceActionStoreLive = DeviceActionStore.layer.pipe(
  Layer.provide(DatabaseLive)
);
