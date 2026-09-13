import {
  enrollmentMembership,
  isTerminalDeviceActionStatus,
} from "@qop/protocol";
import type {
  DeviceActionApiStatus,
  EnrollmentMembership,
} from "@qop/protocol";
import { Effect, Result } from "effect";

export interface EnrollmentSnapshot {
  readonly apiStatus: DeviceActionApiStatus | null;
  readonly historicallyAdded: boolean;
  readonly state: EnrollmentMembership;
}

export const readEnrollmentState = Effect.fn("cli.readEnrollmentState")(
  function* ({
    expectedQid,
    getStatus,
    historicallyAdded = false,
    lookup,
  }: {
    readonly expectedQid: bigint;
    readonly getStatus?:
      | (() => Effect.Effect<DeviceActionApiStatus, unknown>)
      | undefined;
    readonly historicallyAdded?: boolean | undefined;
    readonly lookup: () => Effect.Effect<
      { readonly qid: bigint } | null,
      unknown
    >;
  }) {
    let added = historicallyAdded;
    let apiStatus: DeviceActionApiStatus | null = null;
    if (getStatus) {
      const status = yield* getStatus().pipe(Effect.result);
      if (Result.isSuccess(status)) {
        apiStatus = status.success;
        if (status.success === "confirmed") {
          added = true;
        }
      }
    }
    const current = yield* lookup();
    if (current?.qid === expectedQid) {
      added = true;
    }
    const state: EnrollmentMembership = enrollmentMembership({
      activeQid: current?.qid ?? null,
      expectedQid,
      historicallyAdded: added,
    });
    return { apiStatus, historicallyAdded: added, state };
  }
);

export const pollEnrollmentState = Effect.fn("cli.pollEnrollmentState")(
  function* ({
    delayMs = 2000,
    expectedQid,
    getStatus,
    lookup,
    maxAttempts = 150,
  }: {
    readonly delayMs?: number | undefined;
    readonly expectedQid: bigint;
    readonly getStatus?:
      | (() => Effect.Effect<DeviceActionApiStatus, unknown>)
      | undefined;
    readonly lookup: () => Effect.Effect<
      { readonly qid: bigint } | null,
      unknown
    >;
    readonly maxAttempts?: number | undefined;
  }) {
    let observedAdd = false;
    let snapshot: EnrollmentSnapshot = {
      apiStatus: null,
      historicallyAdded: false,
      state: "pending",
    };
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      snapshot = yield* readEnrollmentState({
        expectedQid,
        getStatus,
        historicallyAdded: observedAdd,
        lookup,
      });
      observedAdd = snapshot.historicallyAdded;
      if (snapshot.state !== "pending") {
        return snapshot;
      }
      if (isTerminalDeviceActionStatus(snapshot.apiStatus)) {
        return snapshot;
      }
      yield* Effect.sleep(delayMs);
    }
    return snapshot;
  }
);
