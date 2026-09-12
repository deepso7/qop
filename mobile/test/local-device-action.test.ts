import {
  decodeAddDeviceIntentV1,
  decodeIdentityEip712DomainV1,
  hashAddDeviceIntentV1,
  signAddDeviceIntentV1,
  EcdsaSignature,
} from "@qop/identity";
import { Effect, Result, Schema } from "effect";
import { hexToBytes } from "viem";
import { describe, expect, it } from "vitest";

import { createLocalDeviceAction } from "@/lib/local-device-action-core";

const DOMAIN = {
  chainId: "31337",
  verifyingContract: "0x1111111111111111111111111111111111111111",
} as const;
const INTENT = {
  deadline: "1700003600",
  deviceKey: `0x${"09".repeat(32)}`,
  nonce: "9",
  qid: "42",
} as const;
const PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
const OWNER = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";

describe("local device action", () => {
  it("persists an approval before submit and conflicts on a different digest", async () => {
    const items = new Map<string, string>();
    const submitted: string[] = [];
    const { persistApproval, markAcknowledged, submitAcknowledged } =
      createLocalDeviceAction({
        deviceActionClient: {
          get: () =>
            Effect.succeed({
              digest: `0x${"00".repeat(32)}`,
              failureCode: null,
              status: "submitted",
              transactionHash: `0x${"ab".repeat(32)}`,
            }),
          submit: (input) => {
            submitted.push(input.operation);
            return Effect.succeed({
              digest: `0x${"00".repeat(32)}`,
              status: "submitted" as const,
              transactionHash: `0x${"ab".repeat(32)}`,
            });
          },
        },
        registry: {
          lookupDeviceKey: () => Effect.succeed(null),
        },
        secureStore: {
          get: (key) => Promise.resolve(items.get(key) ?? null),
          set: (key, value) => {
            items.set(key, value);
            return Promise.resolve();
          },
        },
      });

    const domain = await Effect.runPromise(
      decodeIdentityEip712DomainV1(DOMAIN)
    );
    const intent = await Effect.runPromise(decodeAddDeviceIntentV1(INTENT));
    const digest = await Effect.runPromise(
      hashAddDeviceIntentV1(domain, intent)
    );
    const ownerSignature = await Effect.runPromise(
      signAddDeviceIntentV1(domain, intent, hexToBytes(PRIVATE_KEY)).pipe(
        Effect.flatMap(Schema.encodeEffect(EcdsaSignature))
      )
    );
    const record = {
      digest,
      domain: DOMAIN,
      expectedOwner: OWNER,
      intent: INTENT,
      operation: "add" as const,
      ownerSignature,
      v: 1 as const,
    };

    await Effect.runPromise(persistApproval(record));
    expect(items.size).toBe(1);
    expect(submitted).toEqual([]);

    await Effect.runPromise(markAcknowledged(digest));
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

  it("can persist a removal as already acknowledged", async () => {
    const items = new Map<string, string>();
    const submitted: string[] = [];
    const { persistApproval, submitAcknowledged } = createLocalDeviceAction({
      deviceActionClient: {
        get: () =>
          Effect.succeed({
            digest: `0x${"00".repeat(32)}`,
            failureCode: null,
            status: "submitted",
            transactionHash: `0x${"ab".repeat(32)}`,
          }),
        submit: (input) => {
          submitted.push(input.operation);
          return Effect.succeed({
            digest: `0x${"00".repeat(32)}`,
            status: "submitted" as const,
            transactionHash: `0x${"ab".repeat(32)}`,
          });
        },
      },
      registry: {
        lookupDeviceKey: () => Effect.succeed(null),
      },
      secureStore: {
        get: (key) => Promise.resolve(items.get(key) ?? null),
        set: (key, value) => {
          items.set(key, value);
          return Promise.resolve();
        },
      },
    });
    const domain = await Effect.runPromise(
      decodeIdentityEip712DomainV1(DOMAIN)
    );
    const intent = await Effect.runPromise(decodeAddDeviceIntentV1(INTENT));
    const digest = await Effect.runPromise(
      hashAddDeviceIntentV1(domain, intent)
    );
    const ownerSignature = await Effect.runPromise(
      signAddDeviceIntentV1(domain, intent, hexToBytes(PRIVATE_KEY)).pipe(
        Effect.flatMap(Schema.encodeEffect(EcdsaSignature))
      )
    );
    const record = {
      digest,
      domain: DOMAIN,
      expectedOwner: OWNER,
      intent: INTENT,
      operation: "remove" as const,
      ownerSignature,
      v: 1 as const,
    };
    await Effect.runPromise(persistApproval(record, { acknowledged: true }));
    await Effect.runPromise(submitAcknowledged());
    expect(submitted).toEqual(["remove"]);
  });
});
