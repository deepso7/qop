import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import type { Hash } from "viem";

import {
  DeviceSessionCertificateRejected,
  DeviceSessionProtocolError,
  DeviceSessionService,
} from "../src/device-session/service.ts";
import {
  DeviceSessionChallengeExpired,
  DeviceSessionNotFound,
} from "../src/device-session/store.ts";
import { DeviceObservation } from "../src/device/observation.ts";
import { QopHttpApi } from "../src/http/api.ts";
import {
  DeviceSessionConflictHttp,
  DeviceSessionRejectedHttp,
  DeviceSessionServiceUnavailableHttp,
  DeviceSessionUnauthorizedHttp,
} from "../src/http/device-session-api.ts";
import { QopHttpApiRoutes } from "../src/http/routes.ts";
import { RegistrationEnrollment } from "../src/registration/enrollment.ts";

const DIGEST = `0x${"1".repeat(64)}` as Hash;
const REJECTED_DIGEST = `0x${"2".repeat(64)}` as Hash;
const UNAVAILABLE_DIGEST = `0x${"3".repeat(64)}` as Hash;
const TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PEER_ID = "12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X";
const challenge = {
  certificateDigest: DIGEST,
  challenge: TOKEN,
  expiresAt: "2",
  issuedAt: "1",
  peerId: PEER_ID,
  qid: "42",
  verifier: TOKEN,
  version: 1,
} as const;
const proof = {
  challenge,
  signature: "A".repeat(86),
  version: 1,
} as const;

const DeviceSessionTestLive = Layer.succeed(
  DeviceSessionService,
  DeviceSessionService.of({
    authenticate: () =>
      Effect.fail(new DeviceSessionChallengeExpired({ challengeHash: DIGEST })),
    issue: ({ certificateDigest }) => {
      if (certificateDigest === REJECTED_DIGEST) {
        return Effect.fail(
          new DeviceSessionCertificateRejected({
            certificateDigest,
            reason: "revoked",
          })
        );
      }
      if (certificateDigest === UNAVAILABLE_DIGEST) {
        return Effect.fail(
          new DeviceSessionProtocolError({
            cause: "test failure",
            operation: "encode-challenge",
          })
        );
      }
      assert.strictEqual(certificateDigest, DIGEST);
      return Effect.succeed(challenge);
    },
    resolve: () =>
      Effect.fail(new DeviceSessionNotFound({ tokenHash: DIGEST })),
  })
);

const DeviceObservationUnusedLive = Layer.succeed(
  DeviceObservation,
  DeviceObservation.of({
    observeFromRegistration: () => Effect.die("unused"),
  })
);
const RegistrationEnrollmentUnusedLive = Layer.succeed(
  RegistrationEnrollment,
  RegistrationEnrollment.of({
    authorize: () => Effect.die("unused"),
    prepare: () => Effect.die("unused"),
    reconcile: () => Effect.die("unused"),
  })
);
const RoutesLive = HttpRouter.serve(
  QopHttpApiRoutes.pipe(
    Layer.provide(DeviceObservationUnusedLive),
    Layer.provide(DeviceSessionTestLive),
    Layer.provide(RegistrationEnrollmentUnusedLive)
  ),
  { disableListenLog: true, disableLogger: true }
).pipe(Layer.provideMerge(NodeHttpServer.layerTest));

describe("device session HTTP API", () => {
  it.effect("forwards challenge requests and returns canonical wire data", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(QopHttpApi);
      assert.deepStrictEqual(
        yield* client.deviceSessions.issueDeviceSessionChallenge({
          payload: { certificateDigest: DIGEST },
        }),
        challenge
      );
    }).pipe(Effect.provide(RoutesLive))
  );

  it.effect("maps session failures through the mounted transport", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(QopHttpApi);
      const expired = yield* client.deviceSessions
        .authenticateDeviceSession({ payload: proof })
        .pipe(Effect.flip);
      assert.instanceOf(expired, DeviceSessionConflictHttp);
      assert.strictEqual(expired.kind, "challenge-expired");

      assert.instanceOf(
        yield* client.deviceSessions
          .resolveDeviceSession({ payload: { token: TOKEN } })
          .pipe(Effect.flip),
        DeviceSessionUnauthorizedHttp
      );

      const rejected = yield* client.deviceSessions
        .issueDeviceSessionChallenge({
          payload: { certificateDigest: REJECTED_DIGEST },
        })
        .pipe(Effect.flip);
      assert.instanceOf(rejected, DeviceSessionRejectedHttp);
      assert.strictEqual(rejected.reason, "revoked");

      assert.instanceOf(
        yield* client.deviceSessions
          .issueDeviceSessionChallenge({
            payload: { certificateDigest: UNAVAILABLE_DIGEST },
          })
          .pipe(Effect.flip),
        DeviceSessionServiceUnavailableHttp
      );
    }).pipe(Effect.provide(RoutesLive))
  );
});
