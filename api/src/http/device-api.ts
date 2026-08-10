import { Base64Url32, Hex32, IdentityEnvelopeV1, Qid } from "@qop/identity";
import { Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";

import { registrationIntentStatuses } from "../registration/types.ts";

const CanonicalBase64Url32 = Base64Url32.pipe(
  Schema.decodeTo(Base64Url32.pipe(Schema.flip))
);
const CanonicalDigest = Hex32.pipe(Schema.decodeTo(Hex32.pipe(Schema.flip)));
const CanonicalEnvelope = IdentityEnvelopeV1.pipe(
  Schema.decodeTo(IdentityEnvelopeV1.pipe(Schema.flip))
);
const CanonicalQid = Qid.pipe(Schema.decodeTo(Qid.pipe(Schema.flip)));

export const ObserveRegistrationDevicePayload = Schema.Struct({
  capability: Schema.Struct({
    kind: Schema.Literal("registration"),
    observeToken: CanonicalBase64Url32,
  }),
  envelope: CanonicalEnvelope,
});

export const ObservedDeviceResponse = Schema.Struct({
  certificateDigest: CanonicalDigest,
  qid: CanonicalQid,
  status: Schema.Literal("observed"),
});

export class DeviceObservationUnauthorizedHttp extends Schema.TaggedErrorClass<DeviceObservationUnauthorizedHttp>()(
  "DeviceObservationUnauthorized",
  {},
  { httpApiStatus: 401 }
) {}

export class DeviceObservationConflictHttp extends Schema.TaggedErrorClass<DeviceObservationConflictHttp>()(
  "DeviceObservationConflict",
  {
    actual: Schema.optionalKey(Schema.Literals(registrationIntentStatuses)),
    certificateDigest: Schema.optionalKey(CanonicalDigest),
    kind: Schema.Literals([
      "capability-consumed",
      "registration-not-confirmed",
    ]),
  },
  { httpApiStatus: 409 }
) {}

export class DeviceCertificateRejectedHttp extends Schema.TaggedErrorClass<DeviceCertificateRejectedHttp>()(
  "DeviceCertificateRejected",
  {
    reason: Schema.Literals([
      "future-issued-at",
      "device-commitment",
      "expired",
      "owner-signature",
      "owner-version",
      "peer-id",
      "predates-account",
      "qid",
      "revoked",
    ]),
  },
  { httpApiStatus: 422 }
) {}

export class DeviceObservationInvalidHttp extends Schema.TaggedErrorClass<DeviceObservationInvalidHttp>()(
  "DeviceObservationInvalid",
  {},
  { httpApiStatus: 422 }
) {}

export class DeviceObservationServiceUnavailableHttp extends Schema.TaggedErrorClass<DeviceObservationServiceUnavailableHttp>()(
  "DeviceObservationServiceUnavailable",
  {},
  { httpApiStatus: 503 }
) {}

const DeviceObservationErrors = [
  DeviceObservationUnauthorizedHttp,
  DeviceObservationConflictHttp,
  DeviceCertificateRejectedHttp,
  DeviceObservationInvalidHttp,
  DeviceObservationServiceUnavailableHttp,
] as const;

export class DeviceApiGroup extends HttpApiGroup.make("devices")
  .add(
    HttpApiEndpoint.post("observe", "/observe", {
      error: DeviceObservationErrors,
      payload: ObserveRegistrationDevicePayload,
      success: ObservedDeviceResponse,
    })
  )
  .prefix("/v1/devices")
  .annotateMerge(
    OpenApi.annotations({
      description:
        "Observe public device certificates through a gated enrollment capability.",
      title: "Devices",
    })
  ) {}
