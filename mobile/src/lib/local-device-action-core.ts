import {
  DEVICE_ACTION_DEADLINE_SECONDS,
  DeviceActionApprovalV1,
  acknowledgeApproval,
  decodeDeviceActionApprovalV1,
  enrollmentMembership,
} from "@qop/protocol";
import type { DeviceActionApprovalV1Encoded } from "@qop/protocol";
import { Data, Effect, Result, Schema, Semaphore } from "effect";

import type { createDeviceActionClient } from "./device-action-client-core";
import type { createRegistryReader } from "./registry-core";

const STORAGE_KEY = "qop.device-action.v1";
const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

const StoredDeviceAction = Schema.Struct({
  acknowledged: Schema.Boolean,
  membership: Schema.Literals([
    "linked",
    "pending",
    "removed",
    "wrong-account",
  ]),
  record: DeviceActionApprovalV1,
  submitted: Schema.Boolean,
  transactionHash: Schema.NullOr(Schema.String),
  version: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected local device-action field",
  parseOptions: strictParseOptions,
});

const StoredDeviceActionJson = Schema.fromJsonString(StoredDeviceAction);
export type LocalDeviceAction = typeof StoredDeviceAction.Type;

export class LocalDeviceActionError extends Data.TaggedError(
  "LocalDeviceActionError"
)<{
  readonly operation: "acknowledge" | "conflict" | "decode" | "read" | "write";
}> {}

const localError = (operation: LocalDeviceActionError["operation"]) =>
  new LocalDeviceActionError({ operation });

export interface LocalDeviceActionDependencies {
  readonly deviceActionClient: Pick<
    ReturnType<typeof createDeviceActionClient>,
    "get" | "submit"
  >;
  readonly registry: Pick<
    ReturnType<typeof createRegistryReader>,
    "lookupDeviceKey"
  >;
  readonly secureStore: {
    readonly get: (key: string) => Promise<string | null>;
    readonly set: (key: string, value: string) => Promise<void>;
  };
}

export const createLocalDeviceAction = ({
  deviceActionClient,
  registry,
  secureStore,
}: LocalDeviceActionDependencies) => {
  const lock = Semaphore.makeUnsafe(1);

  const readStored = Effect.fn("LocalDeviceAction.readStored")(function* () {
    const encoded = yield* Effect.tryPromise({
      catch: () => localError("read"),
      try: () => secureStore.get(STORAGE_KEY),
    });
    if (!encoded) {
      return null;
    }
    return yield* Schema.decodeUnknownEffect(StoredDeviceActionJson)(
      encoded
    ).pipe(Effect.mapError(() => localError("decode")));
  });

  const writeStored = Effect.fn("LocalDeviceAction.writeStored")(function* (
    value: LocalDeviceAction
  ) {
    const encoded = yield* Schema.encodeEffect(StoredDeviceActionJson)(
      value
    ).pipe(Effect.mapError(() => localError("write")));
    yield* Effect.tryPromise({
      catch: () => localError("write"),
      try: () => secureStore.set(STORAGE_KEY, encoded),
    });
  });

  const persistApproval = Effect.fn("LocalDeviceAction.persistApproval")(
    (
      record: DeviceActionApprovalV1Encoded,
      options?: { readonly acknowledged?: boolean }
    ) =>
      lock.withPermit(
        Effect.gen(function* () {
          const decoded = yield* decodeDeviceActionApprovalV1(record).pipe(
            Effect.mapError(() => localError("decode"))
          );
          const existing = yield* readStored();
          const ack = acknowledgeApproval(existing?.record ?? null, decoded);
          if (ack.kind === "conflict") {
            return yield* localError("conflict");
          }
          const stored: LocalDeviceAction = {
            acknowledged:
              options?.acknowledged ?? existing?.acknowledged ?? false,
            membership: existing?.membership ?? "pending",
            record: decoded,
            submitted: existing?.submitted ?? false,
            transactionHash: existing?.transactionHash ?? null,
            version: 1,
          };
          // Persist before the approval can reach the CLI or API.
          yield* writeStored(stored);
          return stored;
        })
      )
  );

  const markAcknowledged = Effect.fn("LocalDeviceAction.markAcknowledged")(
    (digest: string) =>
      lock.withPermit(
        Effect.gen(function* () {
          const existing = yield* readStored();
          if (!existing || existing.record.digest !== digest) {
            return yield* localError("acknowledge");
          }
          const stored = { ...existing, acknowledged: true };
          yield* writeStored(stored);
          return stored;
        })
      )
  );

  const submitAcknowledged = Effect.fn("LocalDeviceAction.submitAcknowledged")(
    () =>
      lock.withPermit(
        Effect.gen(function* () {
          const existing = yield* readStored();
          if (!existing?.acknowledged) {
            return yield* localError("acknowledge");
          }
          if (existing.submitted) {
            return existing;
          }
          const encoded = yield* Schema.encodeEffect(DeviceActionApprovalV1)(
            existing.record
          ).pipe(Effect.mapError(() => localError("decode")));
          const result = yield* deviceActionClient
            .submit({
              intent: encoded.intent,
              operation: encoded.operation,
              ownerSignature: encoded.ownerSignature,
            })
            .pipe(Effect.result);
          if (Result.isFailure(result)) {
            return existing;
          }
          const submitted: LocalDeviceAction = {
            ...existing,
            submitted: true,
            transactionHash: result.success.transactionHash,
          };
          yield* writeStored(submitted);
          return submitted;
        })
      )
  );

  const reconcileMembership = Effect.fn(
    "LocalDeviceAction.reconcileMembership"
  )(() =>
    lock.withPermit(
      Effect.gen(function* () {
        const existing = yield* readStored();
        if (!existing) {
          return null;
        }
        const encoded = yield* Schema.encodeEffect(DeviceActionApprovalV1)(
          existing.record
        ).pipe(Effect.mapError(() => localError("decode")));
        const account = yield* registry.lookupDeviceKey(
          encoded.intent.deviceKey
        );
        const membership = enrollmentMembership({
          activeQid: account?.qid ?? null,
          expectedQid: BigInt(existing.record.intent.qid),
          historicallyAdded: existing.submitted,
        });
        const stored = { ...existing, membership };
        yield* writeStored(stored);
        return stored;
      })
    )
  );

  return {
    deadlineSeconds: DEVICE_ACTION_DEADLINE_SECONDS,
    markAcknowledged,
    persistApproval,
    readStored,
    reconcileMembership,
    submitAcknowledged,
  };
};
