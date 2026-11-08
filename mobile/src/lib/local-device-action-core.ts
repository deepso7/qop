import { strictParseOptions } from "@qop/identity";
import {
  DEVICE_ACTION_DEADLINE_SECONDS,
  DeviceActionApprovalV1,
  acknowledgeApproval,
  asHex,
  decodeDeviceActionApprovalV1,
  encodeDeviceActionApprovalV1,
  enrollmentMembership,
  enrollmentPollComplete,
  occupiesApprovalSlot,
} from "@qop/protocol";
import type {
  DeviceActionApiLookup,
  DeviceActionApiStatus,
  DeviceActionApprovalV1Encoded,
} from "@qop/protocol";
import { Data, Effect, Result, Schema, Semaphore } from "effect";

import type { createDeviceActionClient } from "./device-action-client-core";
import type { createRegistryReader } from "./registry-core";

const STORAGE_KEY = "qop.device-action.v1";

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
    | "timeout"
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
    "latestTimestamp" | "lookupDeviceKey"
  >;
  readonly secureStore: {
    readonly get: (key: string) => Promise<string | null>;
    readonly set: (key: string, value: string) => Promise<void>;
  };
}

const DeviceActionGetFailure = Schema.Struct({
  operation: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});

/**
 * A failed GET falls back to the last stored status: a digest the API once
 * returned keeps it (a submitted digest stays occupying past its deadline, a
 * terminal one stays released). Only a never-seen digest can be "missing".
 */
const apiLookupFor = (
  api: Result.Result<{ readonly status: DeviceActionApiStatus }, unknown>,
  storedStatus: DeviceActionApiStatus | null
): DeviceActionApiLookup => {
  if (Result.isSuccess(api)) {
    return { kind: "present", status: api.success.status };
  }

  if (storedStatus !== null) {
    return { kind: "present", status: storedStatus };
  }

  const parsed = Schema.decodeUnknownOption(DeviceActionGetFailure)(
    api.failure
  );

  return parsed._tag === "Some" &&
    (parsed.value.status === 404 || parsed.value.operation === "missing")
    ? { kind: "missing" }
    : { kind: "unknown" };
};

const occupiesStored = (
  existing: LocalDeviceAction,
  extras: {
    readonly api: DeviceActionApiLookup;
    readonly chainTime: bigint | undefined;
  }
) =>
  occupiesApprovalSlot({
    api: extras.api,
    chainTime: extras.chainTime,
    deadline: BigInt(existing.record.intent.deadline),
    membership: existing.membership,
    operation: existing.record.operation,
  });

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
      encoded,
      strictParseOptions
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

  const refreshStored = Effect.fn("LocalDeviceAction.refreshStored")(
    function* () {
      const existing = yield* readStored();

      if (!existing) {
        return {
          api: { kind: "missing" } satisfies DeviceActionApiLookup,
          chainTime: undefined,
          stored: null,
        };
      }

      const encoded = yield* Schema.encodeEffect(DeviceActionApprovalV1)(
        existing.record
      ).pipe(Effect.mapError(() => localError("decode")));

      const api = yield* deviceActionClient
        .get(encoded.digest)
        .pipe(Effect.result);

      const apiLookup = apiLookupFor(api, existing.apiStatus);

      const chainTimeResult = yield* registry
        .latestTimestamp()
        .pipe(Effect.result);

      const chainTime = Result.isSuccess(chainTimeResult)
        ? chainTimeResult.success
        : undefined;

      const account = yield* registry.lookupDeviceKey(encoded.intent.deviceKey);

      const membership = enrollmentMembership({
        activeQid: account?.qid ?? null,
        expectedQid: BigInt(existing.record.intent.qid),
        historicallyAdded:
          existing.historicallyAdded ||
          account?.qid === BigInt(existing.record.intent.qid),
      });

      const stored: LocalDeviceAction = {
        ...existing,
        apiStatus: apiLookup.kind === "present" ? apiLookup.status : null,
        historicallyAdded:
          existing.historicallyAdded || membership === "linked",
        membership,
        transactionHash: Result.isSuccess(api)
          ? (api.success.transactionHash ?? existing.transactionHash)
          : existing.transactionHash,
      };

      yield* writeStored(stored);

      return { api: apiLookup, chainTime, stored };
    }
  );

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

          const refreshed = yield* refreshStored();

          const pending =
            refreshed.stored &&
            occupiesStored(refreshed.stored, {
              api: refreshed.api,
              chainTime: refreshed.chainTime,
            })
              ? refreshed.stored.record
              : null;

          const ack = acknowledgeApproval(pending, decoded);

          if (ack.kind === "conflict") {
            return yield* localError("conflict");
          }

          const stored = storedFromIncoming(refreshed.stored, decoded, options);
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
        const refreshed = yield* refreshStored();

        return refreshed.stored;
      })
    )
  );

  const pollEnrollment = Effect.fn("LocalDeviceAction.pollEnrollment")(
    (delayMs = 2000, maxAttempts = 150) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          const stored = yield* reconcileMembership();

          if (!stored) {
            return null;
          }

          if (
            enrollmentPollComplete({
              apiStatus: stored.apiStatus,
              membership: stored.membership,
              operation: stored.record.operation,
            })
          ) {
            return stored;
          }

          yield* Effect.sleep(delayMs);
        }

        return yield* localError("timeout");
      })
  );

  const resumeInFlight = Effect.fn("LocalDeviceAction.resumeInFlight")(
    (operation: LocalDeviceAction["record"]["operation"], deviceKey: string) =>
      lock.withPermit(
        Effect.gen(function* () {
          const refreshed = yield* refreshStored();

          if (
            !refreshed.stored ||
            !occupiesStored(refreshed.stored, {
              api: refreshed.api,
              chainTime: refreshed.chainTime,
            })
          ) {
            return null;
          }

          if (refreshed.stored.record.operation !== operation) {
            return null;
          }

          if (
            asHex(refreshed.stored.record.intent.deviceKey) !== asHex(deviceKey)
          ) {
            return null;
          }

          return yield* encodeDeviceActionApprovalV1(
            refreshed.stored.record
          ).pipe(Effect.mapError(() => localError("decode")));
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
    resumeInFlight,
    submitAcknowledged,
  };
};
