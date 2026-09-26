import {
  decodeAddDeviceIntentV1,
  decodeIdentityEip712DomainV1,
  hashAddDeviceIntentV1,
  signAddDeviceIntentV1,
  EcdsaSignature,
} from "@qop/identity";
import { PairingOfferV1 } from "@qop/protocol";
import { Effect, Schema } from "effect";
import { hexToBytes } from "viem";
import { describe, expect, it, vi } from "vitest";

import { DeviceActionApprovalError } from "@/lib/device-action-approval-error";
import type {
  ReconciledDeviceAction,
  SubmittedDeviceAction,
} from "@/lib/device-action-client-core";
import { createDeviceLinkFlow } from "@/lib/device-link-flow-core";
import { createLocalDeviceAction } from "@/lib/local-device-action-core";
import type { sendPairingApproval } from "@/lib/pairing-client-core";

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

const dummyOffer = () =>
  Effect.runPromise(
    Schema.decodeUnknownEffect(PairingOfferV1)({
      addrs: ["/ip4/127.0.0.1/udp/4001/quic-v1"],
      chainId: "31337",
      deviceKey: ADD_INTENT.deviceKey,
      expiresAt: "1700003600",
      qid: "42",
      registry: DOMAIN.verifyingContract,
      secret: `0x${"11".repeat(32)}`,
      sessionId: `0x${"22".repeat(32)}`,
      v: 1 as const,
    })
  );

describe("completeDeviceLink", () => {
  it("does not re-sign or resubmit an already-linked add", async () => {
    const items = new Map<string, string>();
    const submitted: string[] = [];
    const action = createLocalDeviceAction({
      deviceActionClient: {
        get: (digest) =>
          Effect.succeed({
            digest,
            failureCode: null,
            status: "confirmed",
            transactionHash: `0x${"ab".repeat(32)}`,
          } satisfies ReconciledDeviceAction),
        submit: (input) => {
          submitted.push(input.operation);
          return Effect.succeed({
            digest: `0x${"00".repeat(32)}`,
            status: "submitted",
            transactionHash: `0x${"ab".repeat(32)}`,
          } satisfies SubmittedDeviceAction);
        },
      },
      registry: {
        latestTimestamp: () => Effect.succeed(1n),
        lookupDeviceKey: () =>
          Effect.succeed({
            blockNumber: 1n,
            deviceKey: ADD_INTENT.deviceKey,
            devices: [],
            freshness: "fresh" as const,
            handle: "alice",
            nonce: 9n,
            owner: OWNER,
            ownerVersion: 1,
            peerId: "12D3KooWaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            qid: 42n,
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
    const record = await signedAdd();
    await Effect.runPromise(action.persistApproval(record));
    await Effect.runPromise(action.markAcknowledged(record.digest));
    await Effect.runPromise(action.submitAcknowledged());
    const linked = await Effect.runPromise(action.reconcileMembership());
    expect(linked?.membership).toBe("linked");
    expect(submitted).toEqual(["add"]);

    const signDeviceActionRecord = vi.fn(() =>
      Effect.fail(new DeviceActionApprovalError({ operation: "sign" }))
    );
    const sendApproval = vi.fn<typeof sendPairingApproval>(() =>
      Effect.succeed(record.digest)
    );
    const { completeDeviceLink } = createDeviceLinkFlow({
      markAcknowledged: action.markAcknowledged,
      persistApproval: action.persistApproval,
      pollEnrollment: action.pollEnrollment,
      reconcileMembership: action.reconcileMembership,
      resumeInFlight: action.resumeInFlight,
      sendPairingApproval: sendApproval,
      signDeviceActionRecord,
      submitAcknowledged: action.submitAcknowledged,
    });

    const result = await Effect.runPromise(
      completeDeviceLink({
        deviceKey: ADD_INTENT.deviceKey,
        expectedOwner: OWNER,
        offer: await dummyOffer(),
        peerId: "12D3KooWaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        qid: 42n,
        transport: {
          connect: () => Promise.reject(new Error("unused")),
          openPairingStream: () => Promise.reject(new Error("unused")),
          waitPeerReady: () => Promise.resolve(),
        },
      })
    );

    expect(result?.membership).toBe("linked");
    expect(signDeviceActionRecord).not.toHaveBeenCalled();
    expect(sendApproval).not.toHaveBeenCalled();
    expect(submitted).toEqual(["add"]);
    expect(
      await Effect.runPromise(
        action.resumeInFlight("add", ADD_INTENT.deviceKey)
      )
    ).toBeNull();
  });
});
