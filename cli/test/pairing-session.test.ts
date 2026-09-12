import { describe, expect, it } from "@effect/vitest";
import {
  decodeAddDeviceIntentV1,
  decodeIdentityEip712DomainV1,
  EcdsaSignature,
  hashAddDeviceIntentV1,
  signAddDeviceIntentV1,
} from "@qop/identity";
import {
  decodeDeviceActionApprovalV1,
  encodeDeviceActionApprovalV1,
  encodePairingOfferV1,
  PairingOfferV1,
} from "@qop/protocol";
import type { DeviceActionApprovalV1Encoded } from "@qop/protocol";
import { Effect, Schema } from "effect";
import { hexToBytes } from "viem";

import {
  createCliPairingSession,
  PairingSessionError,
} from "../src/pairing-session.ts";

const encodedOffer = {
  addrs: [
    "/ip4/127.0.0.1/udp/4001/quic-v1/p2p/12D3KooWC7cDcNR4J3NC9y1gTkqafZKmnjCUvrRMxU2LMugGJGgy",
  ],
  chainId: "31337",
  deviceKey: `0x${"09".repeat(32)}`,
  expiresAt: "1700003600",
  qid: "42",
  registry: "0x1111111111111111111111111111111111111111",
  secret: `0x${"11".repeat(32)}`,
  sessionId: `0x${"22".repeat(32)}`,
  v: 1 as const,
};

const snapshot = {
  chainId: "31337",
  devices: [`0x${"22".repeat(32)}`],
  owner: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
  qid: 42n,
  registry: "0x1111111111111111111111111111111111111111",
};

describe("CLI pairing session", () => {
  it.effect("claims the first phone and rejects a second peer", () =>
    Effect.gen(function* () {
      const offer =
        yield* Schema.decodeUnknownEffect(PairingOfferV1)(encodedOffer);
      yield* encodePairingOfferV1(offer);
      const session = createCliPairingSession({
        loadApproval: () => Effect.succeed(null),
        offer,
        saveApproval: () => Effect.void,
      });
      const secret = hexToBytes(`0x${"11".repeat(32)}`);
      const hello = {
        challenge: `0x${"33".repeat(32)}`,
        secret: `0x${"11".repeat(32)}`,
        sessionId: encodedOffer.sessionId,
        type: "hello" as const,
        v: 1 as const,
      };
      yield* session.hello(
        "phone-a",
        secret,
        `0x${"22".repeat(32)}`,
        snapshot,
        hello
      );
      const second = yield* session
        .hello("phone-b", secret, `0x${"22".repeat(32)}`, snapshot, hello)
        .pipe(Effect.result);
      expect(second._tag).toBe("Failure");
      if (second._tag === "Failure") {
        expect(second.failure).toBeInstanceOf(PairingSessionError);
      }
    })
  );

  it.effect(
    "acks an add-device approval and conflicts on a different digest",
    () =>
      Effect.gen(function* () {
        const offer =
          yield* Schema.decodeUnknownEffect(PairingOfferV1)(encodedOffer);
        let stored: DeviceActionApprovalV1Encoded | undefined;
        const session = createCliPairingSession({
          loadApproval: () =>
            stored
              ? decodeDeviceActionApprovalV1(stored)
              : Effect.succeed(null),
          offer,
          saveApproval: (record) =>
            encodeDeviceActionApprovalV1(record).pipe(
              Effect.map((encoded) => {
                stored = encoded;
                return encoded;
              })
            ),
        });
        const hello = {
          challenge: `0x${"33".repeat(32)}`,
          secret: encodedOffer.secret,
          sessionId: encodedOffer.sessionId,
          type: "hello" as const,
          v: 1 as const,
        };
        yield* session.hello(
          "phone-a",
          encodedOffer.secret,
          snapshot.devices[0] ?? "",
          snapshot,
          hello
        );
        const domain = yield* decodeIdentityEip712DomainV1({
          chainId: snapshot.chainId,
          verifyingContract: snapshot.registry,
        });
        const intent = yield* decodeAddDeviceIntentV1({
          deadline: "1700003600",
          deviceKey: encodedOffer.deviceKey,
          nonce: "9",
          qid: "42",
        });
        const digest = yield* hashAddDeviceIntentV1(domain, intent);
        const ownerSignature = yield* signAddDeviceIntentV1(
          domain,
          intent,
          hexToBytes(
            "0x0000000000000000000000000000000000000000000000000000000000000001"
          )
        ).pipe(Effect.flatMap(Schema.encodeEffect(EcdsaSignature)));
        const encoded = {
          digest,
          domain: {
            chainId: snapshot.chainId,
            verifyingContract: snapshot.registry,
          },
          expectedOwner: snapshot.owner,
          intent: {
            deadline: "1700003600",
            deviceKey: encodedOffer.deviceKey,
            nonce: "9",
            qid: "42",
          },
          operation: "add" as const,
          ownerSignature,
          v: 1 as const,
        };
        const record = yield* decodeDeviceActionApprovalV1(encoded);
        const first = yield* session.receiveApproval(
          "phone-a",
          record,
          snapshot
        );
        expect(first.kind).toBe("saved");
        const replay = yield* session.receiveApproval(
          "phone-a",
          record,
          snapshot
        );
        expect(replay.kind).toBe("saved");
        const otherIntent = yield* decodeAddDeviceIntentV1({
          deadline: "1700003600",
          deviceKey: encodedOffer.deviceKey,
          nonce: "10",
          qid: "42",
        });
        const otherDigest = yield* hashAddDeviceIntentV1(domain, otherIntent);
        const otherSignature = yield* signAddDeviceIntentV1(
          domain,
          otherIntent,
          hexToBytes(
            "0x0000000000000000000000000000000000000000000000000000000000000001"
          )
        ).pipe(Effect.flatMap(Schema.encodeEffect(EcdsaSignature)));
        const otherRecord = yield* decodeDeviceActionApprovalV1({
          ...encoded,
          digest: otherDigest,
          intent: {
            deadline: "1700003600",
            deviceKey: encodedOffer.deviceKey,
            nonce: "10",
            qid: "42",
          },
          ownerSignature: otherSignature,
        });
        const conflict = yield* session.receiveApproval(
          "phone-a",
          otherRecord,
          snapshot
        );
        expect(conflict.kind).toBe("conflict");
      })
  );
});
