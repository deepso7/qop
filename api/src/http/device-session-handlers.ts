import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type { Hash } from "viem";

import type { DeviceSessionServiceError } from "../device-session/service.ts";
import {
  DeviceSessionService,
  DeviceSessionServiceLive,
} from "../device-session/service.ts";
import { QopHttpApi } from "./api.ts";
import {
  DeviceSessionConflictHttp,
  DeviceSessionInvalidHttp,
  DeviceSessionRejectedHttp,
  DeviceSessionServiceUnavailableHttp,
  DeviceSessionUnauthorizedHttp,
} from "./device-session-api.ts";

export const mapDeviceSessionHttpError = (error: DeviceSessionServiceError) => {
  switch (error._tag) {
    case "DeviceSessionCertificateRejected": {
      return new DeviceSessionRejectedHttp({ reason: error.reason });
    }
    case "DeviceSessionChallengeBindingMismatch": {
      return new DeviceSessionConflictHttp({ kind: "binding-mismatch" });
    }
    case "DeviceSessionChallengeConsumed": {
      return new DeviceSessionConflictHttp({ kind: "challenge-consumed" });
    }
    case "DeviceSessionChallengeExpired": {
      return new DeviceSessionConflictHttp({ kind: "challenge-expired" });
    }
    case "DeviceSessionExpired":
    case "DeviceSessionNotFound": {
      return new DeviceSessionUnauthorizedHttp();
    }
    case "DeviceSessionProofInvalid":
    case "DeviceSessionPopCryptoError":
    case "RegistryInputError": {
      return new DeviceSessionInvalidHttp();
    }
    default: {
      return new DeviceSessionServiceUnavailableHttp();
    }
  }
};

const transport = Effect.mapError(mapDeviceSessionHttpError);

export const DeviceSessionApiHandlers = HttpApiBuilder.group(
  QopHttpApi,
  "deviceSessions",
  Effect.fn("DeviceSessionApiHandlers.make")(function* (handlers) {
    const sessions = yield* DeviceSessionService;
    return handlers
      .handle("issueDeviceSessionChallenge", ({ payload }) =>
        sessions
          .issue({ certificateDigest: payload.certificateDigest as Hash })
          .pipe(transport)
      )
      .handle("authenticateDeviceSession", ({ payload }) =>
        sessions.authenticate(payload).pipe(
          transport,
          Effect.map((session) => ({ ...session, qid: session.qid.toString() }))
        )
      )
      .handle("resolveDeviceSession", ({ payload }) =>
        sessions.resolve(payload.token).pipe(
          transport,
          Effect.map((session) => ({ ...session, qid: session.qid.toString() }))
        )
      );
  })
);

export const DeviceSessionApiHandlersLive = DeviceSessionApiHandlers.pipe(
  Layer.provide(DeviceSessionServiceLive)
);
