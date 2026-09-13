import type {
  DeviceActionApiRecord,
  DeviceActionApiStatus,
} from "@qop/protocol";
import { occupiesApprovalSlot } from "@qop/protocol";
import { Effect, Result } from "effect";

import type { DeviceActionStatusError } from "./device-action-status.ts";
import { getDeviceActionStatus } from "./device-action-status.ts";

interface ApiLookup {
  readonly apiRecord: DeviceActionApiRecord;
  readonly apiStatus: DeviceActionApiStatus | null;
}

const apiRecordFromStatus = (
  result: Result.Result<
    { readonly status: DeviceActionApiStatus },
    DeviceActionStatusError
  >
): ApiLookup => {
  if (Result.isSuccess(result)) {
    return {
      apiRecord: "present",
      apiStatus: result.success.status,
    };
  }
  if (result.failure.operation === "missing") {
    return {
      apiRecord: "missing",
      apiStatus: null,
    };
  }
  return {
    apiRecord: "unknown",
    apiStatus: null,
  };
};

interface OccupyingApproval {
  readonly digest: string;
  readonly intent: { readonly deadline: string };
  readonly operation: "add" | "remove";
}

/**
 * Keep pending-approval.json while the digest can still execute. Clear it when
 * GET is 404/missing and the intent deadline is at or before chain time. Do
 * not clear ready/submitted on local clock alone.
 */
export const loadOccupyingApproval = <T extends OccupyingApproval>({
  apiUrl,
  getStatus,
  latestTimestamp,
  store,
}: {
  readonly apiUrl: string | null;
  readonly getStatus?: (
    digest: string
  ) => Effect.Effect<
    { readonly status: DeviceActionApiStatus },
    DeviceActionStatusError
  >;
  readonly latestTimestamp: () => Effect.Effect<bigint, unknown>;
  readonly store: {
    readonly clearApproval: () => Effect.Effect<void, unknown>;
    readonly loadApproval: () => Effect.Effect<T | null, unknown>;
  };
}): Effect.Effect<T | null, unknown> =>
  Effect.gen(function* () {
    const pending = yield* store.loadApproval();
    if (!pending) {
      return null;
    }
    if (!apiUrl && !getStatus) {
      return pending;
    }
    const lookup =
      getStatus ??
      ((digest: string) => getDeviceActionStatus(apiUrl ?? "", digest));
    const status = yield* lookup(pending.digest).pipe(Effect.result);
    const chainTime = yield* latestTimestamp().pipe(Effect.result);
    const { apiRecord, apiStatus } = apiRecordFromStatus(status);
    const occupies = occupiesApprovalSlot({
      apiRecord,
      apiStatus,
      chainTime: Result.isSuccess(chainTime) ? chainTime.success : undefined,
      deadline: BigInt(pending.intent.deadline),
      membership: "pending",
      operation: pending.operation,
    });
    if (!occupies) {
      yield* store.clearApproval();
      return null;
    }
    return pending;
  });
