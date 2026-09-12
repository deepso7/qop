import { assert, describe, it } from "@effect/vitest";
import {
  decodeAddDeviceIntentV1,
  decodeIdentityEip712DomainV1,
  EcdsaSignature,
  hashAddDeviceIntentV1,
  signAddDeviceIntentV1,
} from "@qop/identity";
import { Effect, Schema } from "effect";
import { hexToBytes } from "viem";

import {
  acknowledgeApproval,
  approvalsMatch,
  decodeDeviceActionApprovalV1,
  encodeDeviceActionApprovalV1,
  verifyApprovalDigest,
} from "../src/approval.ts";

const PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
const OWNER = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
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

describe("device-action approval", () => {
  it.effect("acks identical records and conflicts on a different digest", () =>
    Effect.gen(function* () {
      const domain = yield* decodeIdentityEip712DomainV1(DOMAIN);
      const intent = yield* decodeAddDeviceIntentV1(INTENT);
      const digest = yield* hashAddDeviceIntentV1(domain, intent);
      const ownerSignature = yield* signAddDeviceIntentV1(
        domain,
        intent,
        hexToBytes(PRIVATE_KEY)
      ).pipe(Effect.flatMap(Schema.encodeEffect(EcdsaSignature)));
      const record = yield* decodeDeviceActionApprovalV1({
        digest,
        domain: DOMAIN,
        expectedOwner: OWNER,
        intent: INTENT,
        operation: "add",
        ownerSignature,
        v: 1,
      });
      const replay = yield* decodeDeviceActionApprovalV1(
        yield* encodeDeviceActionApprovalV1(record)
      );

      assert.deepStrictEqual(acknowledgeApproval(null, record), {
        digest,
        kind: "saved",
      });
      assert.deepStrictEqual(acknowledgeApproval(record, replay), {
        digest,
        kind: "saved",
      });
      const other = {
        ...record,
        digest: `0x${"ab".repeat(32)}`,
      };
      assert.deepStrictEqual(acknowledgeApproval(record, other), {
        digest,
        kind: "conflict",
      });
      assert.strictEqual(approvalsMatch(record, replay), true);
      assert.strictEqual(approvalsMatch(record, other), false);
      yield* verifyApprovalDigest(record);
    })
  );
});
