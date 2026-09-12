import {
  decodeAddDeviceIntentV1,
  decodeIdentityEip712DomainV1,
  decodeRemoveDeviceIntentV1,
  encodeAddDeviceIntentV1,
  encodeRemoveDeviceIntentV1,
  hashAddDeviceIntentV1,
  hashRemoveDeviceIntentV1,
} from "@qop/identity";
import type { DeviceActionApprovalV1Encoded } from "@qop/protocol";
import { DEVICE_ACTION_DEADLINE_SECONDS } from "@qop/protocol";
import { Data, Effect } from "effect";

import { signApprovedDeviceAction } from "./identity-vault";
import { latestTimestamp, lookupQid } from "./registry";

const PLACEHOLDER_SIGNATURE = `0x${"01".repeat(32)}${"01".repeat(32)}00`;

export class DeviceActionApprovalError extends Data.TaggedError(
  "DeviceActionApprovalError"
)<{
  readonly operation: "sign" | "snapshot";
}> {}

export const trustedIdentityDomain = () => ({
  chainId: process.env.EXPO_PUBLIC_REGISTRY_CHAIN_ID ?? "",
  verifyingContract: (
    process.env.EXPO_PUBLIC_REGISTRY_ADDRESS ?? ""
  ).toLowerCase(),
});

export const signDeviceActionRecord = Effect.fn("signDeviceActionRecord")(
  function* ({
    deviceKey,
    expectedOwner,
    operation,
    qid,
  }: {
    readonly deviceKey: string;
    readonly expectedOwner: string;
    readonly operation: "add" | "remove";
    readonly qid: bigint;
  }) {
    const trustedDomain = trustedIdentityDomain();
    const account = yield* lookupQid(qid);
    if (!account || account.owner !== expectedOwner) {
      return yield* new DeviceActionApprovalError({ operation: "snapshot" });
    }
    const chainTime = yield* latestTimestamp();
    const intentInput = {
      deadline: (chainTime + BigInt(DEVICE_ACTION_DEADLINE_SECONDS)).toString(),
      deviceKey,
      nonce: account.nonce.toString(),
      qid: qid.toString(),
    };
    const domain = yield* decodeIdentityEip712DomainV1(trustedDomain);
    const intent =
      operation === "add"
        ? yield* decodeAddDeviceIntentV1(intentInput)
        : yield* decodeRemoveDeviceIntentV1(intentInput);
    const digest =
      operation === "add"
        ? yield* hashAddDeviceIntentV1(domain, intent)
        : yield* hashRemoveDeviceIntentV1(domain, intent);
    const encodedIntent =
      operation === "add"
        ? yield* encodeAddDeviceIntentV1(intent)
        : yield* encodeRemoveDeviceIntentV1(intent);
    const unsigned: DeviceActionApprovalV1Encoded = {
      digest,
      domain: trustedDomain,
      expectedOwner,
      intent: encodedIntent,
      operation,
      ownerSignature: PLACEHOLDER_SIGNATURE,
      v: 1,
    };
    const ownerSignature = yield* signApprovedDeviceAction({
      displayed: unsigned,
      requested: unsigned,
      snapshot: {
        nonce: account.nonce.toString(),
        owner: expectedOwner,
        qid: qid.toString(),
      },
      trustedDomain,
    });
    return {
      account,
      record: { ...unsigned, ownerSignature },
    };
  }
);
