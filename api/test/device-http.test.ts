import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Base64Url32 } from "@qop/identity";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import type { Hash, Hex } from "viem";

import { DeviceCertificateInputError } from "../src/device/inputs.ts";
import {
  DeviceCertificateRejected,
  DeviceObservation,
  DeviceObservationProtocolError,
  DeviceObservationRegistrationNotConfirmed,
  DeviceObservationUnauthorized,
} from "../src/device/observation.ts";
import { DeviceObservationCapabilityConflict } from "../src/device/store.ts";
import { QopHttpApi } from "../src/http/api.ts";
import {
  DeviceCertificateRejectedHttp,
  DeviceObservationConflictHttp,
  DeviceObservationInvalidHttp,
  DeviceObservationServiceUnavailableHttp,
  DeviceObservationUnauthorizedHttp,
  ObserveRegistrationDevicePayload,
} from "../src/http/device-api.ts";
import { QopHttpApiRoutes } from "../src/http/routes.ts";
import { RegistrationEnrollment } from "../src/registration/enrollment.ts";

const PEER_ID = "12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X";
const OBSERVE_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const observeToken = (id: number) => {
  const bytes = new Uint8Array(32);
  bytes[31] = id;
  return Effect.runSync(Schema.encodeEffect(Base64Url32)(bytes));
};
const UNAUTHORIZED_TOKEN = observeToken(1);
const PENDING_TOKEN = observeToken(2);
const CONSUMED_TOKEN = observeToken(3);
const REJECTED_TOKEN = observeToken(4);
const INVALID_TOKEN = observeToken(5);
const UNAVAILABLE_TOKEN = observeToken(6);
const DECODE_DOMAIN_TOKEN = observeToken(7);
const SIGNATURE = `0x${"1".padStart(64, "0")}${"1".padStart(64, "0")}00` as Hex;
const CERTIFICATE_DIGEST =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as Hash;

const envelope = {
  certificate: {
    encryptionPublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    issuedAt: "1700000000",
    ownerVersion: 0,
    peerId: PEER_ID,
    qid: "42",
    salt: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
    version: 1,
  },
  signature: SIGNATURE,
  version: 1,
} as const;

const DeviceObservationTestLive = Layer.succeed(
  DeviceObservation,
  DeviceObservation.of({
    observeFromRegistration: (input) =>
      Effect.gen(function* () {
        switch (input.observeToken) {
          case UNAUTHORIZED_TOKEN: {
            return yield* new DeviceObservationUnauthorized();
          }
          case PENDING_TOKEN: {
            return yield* new DeviceObservationRegistrationNotConfirmed({
              actual: "pending_owner_signature",
            });
          }
          case CONSUMED_TOKEN: {
            return yield* new DeviceObservationCapabilityConflict({
              certificateDigest: CERTIFICATE_DIGEST,
              registrationIntentDigest: CERTIFICATE_DIGEST,
            });
          }
          case REJECTED_TOKEN: {
            return yield* new DeviceCertificateRejected({ reason: "revoked" });
          }
          case INVALID_TOKEN: {
            return yield* new DeviceCertificateInputError({
              cause: "test failure",
              field: "envelope",
            });
          }
          case UNAVAILABLE_TOKEN: {
            return yield* new DeviceObservationProtocolError({
              cause: "test failure",
              operation: "encode-envelope",
            });
          }
          case DECODE_DOMAIN_TOKEN: {
            return yield* new DeviceObservationProtocolError({
              cause: "test failure",
              operation: "decode-domain",
            });
          }
          default: {
            assert.deepStrictEqual(input, {
              envelope,
              observeToken: OBSERVE_TOKEN,
            });
            return {
              certificateDigest: CERTIFICATE_DIGEST,
              envelope,
              observedAt: new Date(0),
              qid: 42n,
            };
          }
        }
      }),
  })
);

const RegistrationEnrollmentUnusedTestLive = Layer.succeed(
  RegistrationEnrollment,
  RegistrationEnrollment.of({
    authorize: () => Effect.die("not used by device HTTP tests"),
    prepare: () => Effect.die("not used by device HTTP tests"),
    reconcile: () => Effect.die("not used by device HTTP tests"),
  })
);

const ApiRoutesTestLive = HttpRouter.serve(
  QopHttpApiRoutes.pipe(
    Layer.provide(DeviceObservationTestLive),
    Layer.provide(RegistrationEnrollmentUnusedTestLive)
  ),
  { disableListenLog: true, disableLogger: true }
).pipe(Layer.provideMerge(NodeHttpServer.layerTest));

describe("device observation HTTP API", () => {
  it.effect("forwards a registration capability and returns wire values", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(QopHttpApi);
      const observed = yield* client.devices.observe({
        payload: {
          capability: {
            kind: "registration",
            observeToken: OBSERVE_TOKEN,
          },
          envelope,
        },
      });

      assert.deepStrictEqual(observed, {
        certificateDigest: CERTIFICATE_DIGEST,
        qid: "42",
        status: "observed",
      });
    }).pipe(Effect.provide(ApiRoutesTestLive))
  );

  it.effect("keeps the full identity envelope codec at the HTTP boundary", () =>
    Effect.gen(function* () {
      const invalidQid = yield* Schema.decodeUnknownEffect(
        ObserveRegistrationDevicePayload
      )({
        capability: { kind: "registration", observeToken: OBSERVE_TOKEN },
        envelope: {
          ...envelope,
          certificate: { ...envelope.certificate, qid: "0" },
        },
      }).pipe(Effect.exit);
      const invalidToken = yield* Schema.decodeUnknownEffect(
        ObserveRegistrationDevicePayload
      )({
        capability: {
          kind: "registration",
          observeToken: `${"A".repeat(42)}B`,
        },
        envelope,
      }).pipe(Effect.exit);

      assert.strictEqual(invalidQid._tag, "Failure");
      assert.strictEqual(invalidToken._tag, "Failure");
    })
  );

  it.effect("maps domain failures through the mounted HTTP transport", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(QopHttpApi);
      const request = (token: string) =>
        client.devices
          .observe({
            payload: {
              capability: { kind: "registration", observeToken: token },
              envelope,
            },
          })
          .pipe(Effect.flip);

      assert.instanceOf(
        yield* request(UNAUTHORIZED_TOKEN),
        DeviceObservationUnauthorizedHttp
      );

      const pending = yield* request(PENDING_TOKEN);
      assert.instanceOf(pending, DeviceObservationConflictHttp);
      assert.strictEqual(pending.kind, "registration-not-confirmed");
      assert.strictEqual(pending.actual, "pending_owner_signature");

      const consumed = yield* request(CONSUMED_TOKEN);
      assert.instanceOf(consumed, DeviceObservationConflictHttp);
      assert.strictEqual(consumed.kind, "capability-consumed");
      assert.strictEqual(consumed.certificateDigest, CERTIFICATE_DIGEST);

      const rejected = yield* request(REJECTED_TOKEN);
      assert.instanceOf(rejected, DeviceCertificateRejectedHttp);
      assert.strictEqual(rejected.reason, "revoked");

      assert.instanceOf(
        yield* request(INVALID_TOKEN),
        DeviceObservationInvalidHttp
      );
      assert.instanceOf(
        yield* request(UNAVAILABLE_TOKEN),
        DeviceObservationInvalidHttp
      );
      assert.instanceOf(
        yield* request(DECODE_DOMAIN_TOKEN),
        DeviceObservationServiceUnavailableHttp
      );
    }).pipe(Effect.provide(ApiRoutesTestLive))
  );
});
