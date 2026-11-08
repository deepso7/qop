import type {
  DeviceActionApiLookup,
  DeviceActionApiStatus,
} from "@qop/protocol";
import { occupiesApprovalSlot } from "@qop/protocol";
import { Effect, Result } from "effect";

import type { DeviceActionStatusError } from "./device-action-status.ts";
import { getDeviceActionStatus } from "./device-action-status.ts";

const apiLookupFromStatus = (
  result: Result.Result<
    { readonly status: DeviceActionApiStatus },
    DeviceActionStatusError
  >
): DeviceActionApiLookup => {
  if (Result.isSuccess(result)) {
    return { kind: "present", status: result.success.status };
  }

  return result.failure.operation === "missing"
    ? { kind: "missing" }
    : { kind: "unknown" };
};

interface OccupyingApproval {
  readonly digest: string;
  readonly intent: { readonly deadline: string };
  readonly operation: "add" | "remove";
}

/**
 * Keep pending-approval.json while the digest can still execute. Clear it when
 * GET is 404/missing and chain time is strictly after the intent deadline. Do
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

    const occupies = occupiesApprovalSlot({
      api: apiLookupFromStatus(status),
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
