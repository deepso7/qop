import { enrollmentMembership } from "@qop/protocol";
import type {
  DeviceActionApiStatus,
  EnrollmentMembership,
} from "@qop/protocol";
import { Effect, Result } from "effect";

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
    if (getStatus) {
      const status = yield* getStatus().pipe(Effect.result);
      if (Result.isSuccess(status) && status.success === "confirmed") {
        added = true;
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
    return { historicallyAdded: added, state };
  }
);

export const pollEnrollmentState = Effect.fn("cli.pollEnrollmentState")(
  function* ({
    delayMs = 2000,
    expectedQid,
    getStatus,
    lookup,
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
  }) {
    let observedAdd = false;
    while (true) {
      const snapshot: {
        readonly historicallyAdded: boolean;
        readonly state: EnrollmentMembership;
      } = yield* readEnrollmentState({
        expectedQid,
        getStatus,
        historicallyAdded: observedAdd,
        lookup,
      });
      observedAdd = snapshot.historicallyAdded;
      if (snapshot.state !== "pending") {
        return snapshot.state;
      }
      yield* Effect.sleep(delayMs);
    }
  }
);
