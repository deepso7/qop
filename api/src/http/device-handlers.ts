import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import type { DeviceObservationError } from "../device/observation.ts";
import {
  DeviceObservation,
  DeviceObservationLive,
} from "../device/observation.ts";
import { QopHttpApi } from "./api.ts";
import {
  DeviceCertificateRejectedHttp,
  DeviceObservationConflictHttp,
  DeviceObservationInvalidHttp,
  DeviceObservationServiceUnavailableHttp,
  DeviceObservationUnauthorizedHttp,
} from "./device-api.ts";

export type DeviceObservationHttpError =
  | DeviceCertificateRejectedHttp
  | DeviceObservationConflictHttp
  | DeviceObservationInvalidHttp
  | DeviceObservationServiceUnavailableHttp
  | DeviceObservationUnauthorizedHttp;

export const mapDeviceObservationHttpError = (
  error: DeviceObservationError
): DeviceObservationHttpError => {
  switch (error._tag) {
    case "DeviceObservationUnauthorized": {
      return new DeviceObservationUnauthorizedHttp();
    }
    case "DeviceObservationRegistrationNotConfirmed": {
      return new DeviceObservationConflictHttp({
        actual: error.actual,
        kind: "registration-not-confirmed",
      });
    }
    case "DeviceObservationCapabilityConflict": {
      return new DeviceObservationConflictHttp({
        certificateDigest: error.certificateDigest,
        kind: "capability-consumed",
      });
    }
    case "DeviceCertificateRejected": {
      return new DeviceCertificateRejectedHttp({ reason: error.reason });
    }
    case "DeviceCertificateInputError":
    case "IdentityCryptoError":
    case "RegistrationInputError":
    case "RegistryInputError": {
      return new DeviceObservationInvalidHttp();
    }
    case "DeviceObservationProtocolError": {
      return error.operation === "decode-domain"
        ? new DeviceObservationServiceUnavailableHttp()
        : new DeviceObservationInvalidHttp();
    }
    default: {
      return new DeviceObservationServiceUnavailableHttp();
    }
  }
};

const transportErrors = Effect.mapError(mapDeviceObservationHttpError);

export const DeviceApiHandlers = HttpApiBuilder.group(
  QopHttpApi,
  "devices",
  Effect.fn("DeviceApiHandlers.make")(function* (handlers) {
    const observation = yield* DeviceObservation;

    return handlers.handle("observe", ({ payload }) =>
      observation
        .observeFromRegistration({
          envelope: payload.envelope,
          observeToken: payload.capability.observeToken,
        })
        .pipe(
          transportErrors,
          Effect.map((device) => ({
            certificateDigest: device.certificateDigest,
            qid: device.qid.toString(),
            status: "observed" as const,
          }))
        )
    );
  })
);

export const DeviceApiHandlersLive = DeviceApiHandlers.pipe(
  Layer.provide(DeviceObservationLive)
);
