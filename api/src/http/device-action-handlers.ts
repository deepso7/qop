import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import type { DeviceActionEnrollmentError } from "../device-action/enrollment.ts";
import { DeviceActionEnrollment } from "../device-action/enrollment.ts";
import { normalizeRegistrationDigest } from "../registration/inputs.ts";
import { QopHttpApi } from "./api.ts";
import {
  DeviceActionConflict,
  DeviceActionInvalid,
  DeviceActionNotFound,
  DeviceActionServiceUnavailable,
} from "./device-action-api.ts";

export type DeviceActionHttpError =
  | DeviceActionConflict
  | DeviceActionInvalid
  | DeviceActionNotFound
  | DeviceActionServiceUnavailable;

export const mapDeviceActionHttpError = (
  error: DeviceActionEnrollmentError
): DeviceActionHttpError => {
  switch (error._tag) {
    case "DeviceActionInFlightConflict": {
      return new DeviceActionConflict({
        digest: error.digest,
        kind: "in-flight",
      });
    }
    case "DeviceActionTransitionConflict": {
      return new DeviceActionConflict({
        actual: error.actual,
        kind: "transition-conflict",
      });
    }
    case "DeviceActionIntentNotFound": {
      return new DeviceActionNotFound({ digest: error.digest });
    }
    case "DeviceActionDeadlineInvalid":
    case "DeviceActionIntentConflict":
    case "DeviceActionRosterInvalid":
    case "DeviceActionSignatureMismatch":
    case "IdentityCryptoError":
    case "RegistrationInputError":
    case "DeviceActionProtocolError": {
      return new DeviceActionInvalid();
    }
    default: {
      return new DeviceActionServiceUnavailable();
    }
  }
};

const transportErrors = Effect.mapError(mapDeviceActionHttpError);

export const DeviceActionApiHandlers = HttpApiBuilder.group(
  QopHttpApi,
  "device-actions",
  Effect.fn("DeviceActionApiHandlers.make")(function* (handlers) {
    const enrollment = yield* DeviceActionEnrollment;

    return handlers
      .handle("submit", ({ payload }) =>
        enrollment.submit(payload).pipe(transportErrors)
      )
      .handle("get", ({ params }) =>
        normalizeRegistrationDigest(params.digest).pipe(
          Effect.flatMap(enrollment.reconcile),
          transportErrors
        )
      );
  })
);

export const DeviceActionApiHandlersLive = DeviceActionApiHandlers.pipe(
  Layer.provide(DeviceActionEnrollment.layer)
);
