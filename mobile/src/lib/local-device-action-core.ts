import {
  DEVICE_ACTION_DEADLINE_SECONDS,
  DeviceActionApprovalV1,
  acknowledgeApproval,
  asHex,
  decodeDeviceActionApprovalV1,
  encodeDeviceActionApprovalV1,
  enrollmentMembership,
  occupiesApprovalSlot,
} from "@qop/protocol";
import type {
  DeviceActionApiStatus,
  DeviceActionApprovalV1Encoded,
} from "@qop/protocol";
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
  apiStatus: Schema.NullOr(
    Schema.Literals(["ready", "submitted", "confirmed", "reverted", "expired"])
  ),
  historicallyAdded: Schema.Boolean,
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
  readonly operation:
    | "acknowledge"
    | "conflict"
    | "decode"
    | "read"
    | "submit"
    | "write";
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

const slotRecord = (existing: LocalDeviceAction | null) =>
  existing && occupiesApprovalSlot(existing) ? existing.record : null;

const storedFromIncoming = (
  existing: LocalDeviceAction | null,
  decoded: LocalDeviceAction["record"],
  options?: { readonly acknowledged?: boolean }
): LocalDeviceAction => {
  if (existing?.record.digest === decoded.digest) {
    return {
      ...existing,
      acknowledged: options?.acknowledged ?? existing.acknowledged,
      record: decoded,
    };
  }
  return {
    acknowledged: options?.acknowledged ?? false,
    apiStatus: null,
    historicallyAdded: false,
    membership: "pending",
    record: decoded,
    submitted: false,
    transactionHash: null,
    version: 1,
  };
};

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
          const pending = slotRecord(existing);
          const ack = acknowledgeApproval(pending, decoded);
          if (ack.kind === "conflict") {
            return yield* localError("conflict");
          }
          const stored = storedFromIncoming(existing, decoded, options);
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
          if (!existing.submitted) {
            const encoded = yield* Schema.encodeEffect(DeviceActionApprovalV1)(
              existing.record
            ).pipe(Effect.mapError(() => localError("decode")));
            const result = yield* deviceActionClient
              .submit({
                intent: encoded.intent,
                operation: encoded.operation,
                ownerSignature: encoded.ownerSignature,
              })
              .pipe(Effect.mapError(() => localError("submit")));
            const submitted: LocalDeviceAction = {
              ...existing,
              apiStatus: result.status,
              submitted: true,
              transactionHash: result.transactionHash,
            };
            yield* writeStored(submitted);
            return submitted;
          }
          const status = yield* deviceActionClient
            .get(existing.record.digest)
            .pipe(Effect.result);
          if (Result.isFailure(status)) {
            return existing;
          }
          const refreshed: LocalDeviceAction = {
            ...existing,
            apiStatus: status.success.status,
            historicallyAdded:
              existing.historicallyAdded ||
              status.success.status === "confirmed",
            transactionHash:
              status.success.transactionHash ?? existing.transactionHash,
          };
          yield* writeStored(refreshed);
          return refreshed;
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
        const api = yield* deviceActionClient
          .get(encoded.digest)
          .pipe(Effect.result);
        const apiStatus: DeviceActionApiStatus | null = Result.isSuccess(api)
          ? api.success.status
          : existing.apiStatus;
        const historicallyAdded =
          existing.historicallyAdded || apiStatus === "confirmed";
        const account = yield* registry.lookupDeviceKey(
          encoded.intent.deviceKey
        );
        const membership = enrollmentMembership({
          activeQid: account?.qid ?? null,
          expectedQid: BigInt(existing.record.intent.qid),
          historicallyAdded:
            historicallyAdded ||
            account?.qid === BigInt(existing.record.intent.qid),
        });
        const stored: LocalDeviceAction = {
          ...existing,
          apiStatus,
          historicallyAdded: historicallyAdded || membership === "linked",
          membership,
          transactionHash: Result.isSuccess(api)
            ? (api.success.transactionHash ?? existing.transactionHash)
            : existing.transactionHash,
        };
        yield* writeStored(stored);
        return stored;
      })
    )
  );

  const pollEnrollment = Effect.fn("LocalDeviceAction.pollEnrollment")(
    (delayMs = 2000) =>
      Effect.gen(function* () {
        while (true) {
          const stored = yield* reconcileMembership();
          if (!stored) {
            return null;
          }
          if (stored.membership !== "pending") {
            return stored;
          }
          if (!occupiesApprovalSlot(stored)) {
            return stored;
          }
          yield* Effect.sleep(delayMs);
        }
      })
  );

  const resumeInFlightAdd = Effect.fn("LocalDeviceAction.resumeInFlightAdd")(
    (deviceKey: string) =>
      lock.withPermit(
        Effect.gen(function* () {
          const existing = yield* readStored();
          if (!existing || !occupiesApprovalSlot(existing)) {
            return null;
          }
          if (existing.record.operation !== "add") {
            return null;
          }
          if (asHex(existing.record.intent.deviceKey) !== asHex(deviceKey)) {
            return null;
          }
          return yield* encodeDeviceActionApprovalV1(existing.record).pipe(
            Effect.mapError(() => localError("decode"))
          );
        })
      )
  );

  return {
    deadlineSeconds: DEVICE_ACTION_DEADLINE_SECONDS,
    markAcknowledged,
    persistApproval,
    pollEnrollment,
    readStored,
    reconcileMembership,
    resumeInFlightAdd,
    submitAcknowledged,
  };
};
