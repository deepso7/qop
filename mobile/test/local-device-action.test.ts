import {
  decodeAddDeviceIntentV1,
  decodeIdentityEip712DomainV1,
  decodeRemoveDeviceIntentV1,
  hashAddDeviceIntentV1,
  hashRemoveDeviceIntentV1,
  signAddDeviceIntentV1,
  signRemoveDeviceIntentV1,
  EcdsaSignature,
} from "@qop/identity";
import { Effect, Result, Schema } from "effect";
import { hexToBytes } from "viem";
import { describe, expect, it } from "vitest";

import { DeviceActionClientError } from "@/lib/device-action-client-core";
import type {
  ReconciledDeviceAction,
  SubmittedDeviceAction,
} from "@/lib/device-action-client-core";
import { createLocalDeviceAction } from "@/lib/local-device-action-core";

const DOMAIN = {
  chainId: "31337",
  verifyingContract: "0x1111111111111111111111111111111111111111",
} as const;
const ADD_INTENT = {
  deadline: "1700003600",
  deviceKey: `0x${"09".repeat(32)}`,
  nonce: "9",
  qid: "42",
} as const;
const REMOVE_INTENT = {
  deadline: "1700003600",
  deviceKey: `0x${"09".repeat(32)}`,
  nonce: "10",
  qid: "42",
} as const;
const PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
const OWNER = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";

const signedAdd = async () => {
  const domain = await Effect.runPromise(decodeIdentityEip712DomainV1(DOMAIN));
  const intent = await Effect.runPromise(decodeAddDeviceIntentV1(ADD_INTENT));
  const digest = await Effect.runPromise(hashAddDeviceIntentV1(domain, intent));
  const ownerSignature = await Effect.runPromise(
    signAddDeviceIntentV1(domain, intent, hexToBytes(PRIVATE_KEY)).pipe(
      Effect.flatMap(Schema.encodeEffect(EcdsaSignature))
    )
  );
  return {
    digest,
    domain: DOMAIN,
    expectedOwner: OWNER,
    intent: ADD_INTENT,
    operation: "add" as const,
    ownerSignature,
    v: 1 as const,
  };
};

const signedRemove = async () => {
  const domain = await Effect.runPromise(decodeIdentityEip712DomainV1(DOMAIN));
  const intent = await Effect.runPromise(
    decodeRemoveDeviceIntentV1(REMOVE_INTENT)
  );
  const digest = await Effect.runPromise(
    hashRemoveDeviceIntentV1(domain, intent)
  );
  const ownerSignature = await Effect.runPromise(
    signRemoveDeviceIntentV1(domain, intent, hexToBytes(PRIVATE_KEY)).pipe(
      Effect.flatMap(Schema.encodeEffect(EcdsaSignature))
    )
  );
  return {
    digest,
    domain: DOMAIN,
    expectedOwner: OWNER,
    intent: REMOVE_INTENT,
    operation: "remove" as const,
    ownerSignature,
    v: 1 as const,
  };
};

const createHarness = ({
  getStatus = "submitted",
  lookupQid,
  submitFails = false,
}: {
  readonly getStatus?: ReconciledDeviceAction["status"];
  readonly lookupQid?: bigint | null;
  readonly submitFails?: boolean;
} = {}) => {
  const items = new Map<string, string>();
  const submitted: string[] = [];
  const activeQid = lookupQid ?? null;
  const action = createLocalDeviceAction({
    deviceActionClient: {
      get: (digest) =>
        Effect.succeed({
          digest,
          failureCode: null,
          status: getStatus,
          transactionHash: `0x${"ab".repeat(32)}`,
        } satisfies ReconciledDeviceAction),
      submit: (input) => {
        submitted.push(input.operation);
        if (submitFails) {
          return Effect.fail(
            new DeviceActionClientError({ kind: "network", status: null })
          );
        }
        return Effect.succeed({
          digest: `0x${"00".repeat(32)}`,
          status: "submitted",
          transactionHash: `0x${"ab".repeat(32)}`,
        } satisfies SubmittedDeviceAction);
      },
    },
    registry: {
      lookupDeviceKey: () =>
        activeQid === null
          ? Effect.succeed(null)
          : Effect.succeed({
              blockNumber: 1n,
              deviceKey: ADD_INTENT.deviceKey,
              devices: [],
              freshness: "fresh" as const,
              handle: "alice",
              nonce: 9n,
              owner: OWNER,
              ownerVersion: 1,
              peerId: "12D3KooWaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              qid: activeQid,
              registeredAt: 1n,
            }),
    },
    secureStore: {
      get: (key) => Promise.resolve(items.get(key) ?? null),
      set: (key, value) => {
        items.set(key, value);
        return Promise.resolve();
      },
    },
  });
  return { ...action, submitted };
};

describe("local device action", () => {
  it("persists an approval before submit and conflicts while the digest is in flight", async () => {
    const { persistApproval, markAcknowledged, submitAcknowledged, submitted } =
      createHarness();
    const record = await signedAdd();

    await Effect.runPromise(persistApproval(record));
    expect(submitted).toEqual([]);

    await Effect.runPromise(markAcknowledged(record.digest));
    await Effect.runPromise(submitAcknowledged());
    expect(submitted).toEqual(["add"]);

    const conflict = await Effect.runPromise(
      persistApproval({
        ...record,
        digest: `0x${"cd".repeat(32)}`,
      }).pipe(Effect.result)
    );
    expect(Result.isFailure(conflict) && conflict.failure.operation).toBe(
      "conflict"
    );
  });

  it("does not treat submitted as historically added", async () => {
    const {
      persistApproval,
      markAcknowledged,
      submitAcknowledged,
      reconcileMembership,
    } = createHarness({ getStatus: "submitted", lookupQid: null });
    const record = await signedAdd();
    await Effect.runPromise(persistApproval(record));
    await Effect.runPromise(markAcknowledged(record.digest));
    await Effect.runPromise(submitAcknowledged());
    const stored = await Effect.runPromise(reconcileMembership());
    expect(stored?.membership).toBe("pending");
    expect(stored?.historicallyAdded).toBe(false);
  });

  it("releases the slot after confirmed membership so a remove can persist", async () => {
    const addHarness = createHarness({
      getStatus: "confirmed",
      lookupQid: 42n,
    });
    const addRecord = await signedAdd();
    await Effect.runPromise(addHarness.persistApproval(addRecord));
    await Effect.runPromise(addHarness.markAcknowledged(addRecord.digest));
    await Effect.runPromise(addHarness.submitAcknowledged());
    const linked = await Effect.runPromise(addHarness.reconcileMembership());
    expect(linked?.membership).toBe("linked");

    const removeRecord = await signedRemove();
    const saved = await Effect.runPromise(
      addHarness
        .persistApproval(removeRecord, { acknowledged: true })
        .pipe(Effect.result)
    );
    expect(Result.isSuccess(saved)).toBe(true);
  });

  it("resumes the same in-flight add digest without treating it as removed", async () => {
    const harness = createHarness({ getStatus: "submitted", lookupQid: null });
    const record = await signedAdd();
    await Effect.runPromise(harness.persistApproval(record));
    const resumed = await Effect.runPromise(
      harness.resumeInFlight("add", record.intent.deviceKey)
    );
    expect(resumed?.digest).toBe(record.digest);
    await Effect.runPromise(harness.persistApproval(resumed ?? record));
    const stored = await Effect.runPromise(harness.reconcileMembership());
    expect(stored?.membership).toBe("pending");
  });

  it("fails closed when submit does not reach the API", async () => {
    const harness = createHarness({ submitFails: true });
    const record = await signedAdd();
    await Effect.runPromise(harness.persistApproval(record));
    await Effect.runPromise(harness.markAcknowledged(record.digest));
    const submitted = await Effect.runPromise(
      harness.submitAcknowledged().pipe(Effect.result)
    );
    expect(Result.isFailure(submitted) && submitted.failure.operation).toBe(
      "submit"
    );
    expect(harness.submitted).toEqual(["add"]);
  });

  it("can persist a removal as already acknowledged on an empty slot", async () => {
    const harness = createHarness();
    const record = await signedRemove();
    await Effect.runPromise(
      harness.persistApproval(record, { acknowledged: true })
    );
    await Effect.runPromise(harness.submitAcknowledged());
    expect(harness.submitted).toEqual(["remove"]);
  });

  it("keeps the slot for a submitted remove while the device is still active", async () => {
    const harness = createHarness({
      getStatus: "submitted",
      lookupQid: 42n,
    });
    const record = await signedRemove();
    await Effect.runPromise(
      harness.persistApproval(record, { acknowledged: true })
    );
    await Effect.runPromise(harness.submitAcknowledged());
    const stored = await Effect.runPromise(harness.reconcileMembership());
    expect(stored?.membership).toBe("linked");

    const conflict = await Effect.runPromise(
      harness
        .persistApproval({
          ...record,
          digest: `0x${"cd".repeat(32)}`,
        })
        .pipe(Effect.result)
    );
    expect(Result.isFailure(conflict) && conflict.failure.operation).toBe(
      "conflict"
    );

    const resumed = await Effect.runPromise(
      harness.resumeInFlight("remove", record.intent.deviceKey)
    );
    expect(resumed?.digest).toBe(record.digest);
  });

  it("times out enrollment polling instead of waiting forever", async () => {
    const harness = createHarness({ getStatus: "submitted", lookupQid: null });
    const record = await signedAdd();
    await Effect.runPromise(harness.persistApproval(record));
    await Effect.runPromise(harness.markAcknowledged(record.digest));
    await Effect.runPromise(harness.submitAcknowledged());
    const polled = await Effect.runPromise(
      harness.pollEnrollment(0, 2).pipe(Effect.result)
    );
    expect(Result.isFailure(polled) && polled.failure.operation).toBe(
      "timeout"
    );
  });

  it("releases an expired digest so a later approval can persist", async () => {
    const harness = createHarness({ getStatus: "expired", lookupQid: null });
    const record = await signedAdd();
    await Effect.runPromise(harness.persistApproval(record));
    await Effect.runPromise(harness.markAcknowledged(record.digest));
    await Effect.runPromise(harness.submitAcknowledged());
    const stored = await Effect.runPromise(harness.reconcileMembership());
    expect(stored?.membership).toBe("pending");
    expect(stored?.apiStatus).toBe("expired");

    const next = await signedAdd();
    const saved = await Effect.runPromise(
      harness.persistApproval(next).pipe(Effect.result)
    );
    expect(Result.isSuccess(saved)).toBe(true);
  });
});
