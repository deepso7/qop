import { AddDeviceIntentV1, Hex32, RemoveDeviceIntentV1 } from "@qop/identity";
import { Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";

import { deviceActionIntentStatuses } from "../device-action/types.ts";

const canonical = <S extends Schema.Top>(schema: S) =>
  schema.pipe(Schema.decodeTo(schema.pipe(Schema.flip)));

const Digest = canonical(Hex32);
const CanonicalAddIntent = canonical(AddDeviceIntentV1);
const CanonicalRemoveIntent = canonical(RemoveDeviceIntentV1);

const schemaTaggedError = Schema.TaggedError;

const WalletSignatureInput = Schema.String.check(
  Schema.isPattern(/^0x[0-9a-f]{128}(?:00|01|1b|1c)$/iu, {
    expected: "a 65-byte ECDSA signature ending in yParity 0/1 or v 27/28",
  })
);

const DigestInput = Schema.String.check(
  Schema.isPattern(/^0x[0-9a-f]{64}$/iu, {
    expected: "a 32-byte 0x-prefixed digest",
  })
);

export const SubmitDeviceActionPayload = Schema.Union([
  Schema.Struct({
    intent: CanonicalAddIntent,
    operation: Schema.Literal("add"),
    ownerSignature: WalletSignatureInput,
  }),
  Schema.Struct({
    intent: CanonicalRemoveIntent,
    operation: Schema.Literal("remove"),
    ownerSignature: WalletSignatureInput,
  }),
]);

export const SubmittedDeviceActionResponse = Schema.Struct({
  digest: Digest,
  status: Schema.Literals(["submitted", "confirmed"]),
  transactionHash: Digest,
});

export const ReconciledDeviceActionResponse = Schema.Struct({
  digest: Digest,
  failureCode: Schema.NullOr(Schema.String),
  status: Schema.Literals(deviceActionIntentStatuses),
  transactionHash: Schema.NullOr(Digest),
});

export class DeviceActionConflict extends schemaTaggedError<DeviceActionConflict>()(
  "DeviceActionConflict",
  {
    actual: Schema.optionalKey(Schema.Literals(deviceActionIntentStatuses)),
    digest: Schema.optionalKey(Digest),
    kind: Schema.Literals(["in-flight", "transition-conflict"]),
  },
  { httpApiStatus: 409 }
) {}

export class DeviceActionNotFound extends schemaTaggedError<DeviceActionNotFound>()(
  "DeviceActionNotFound",
  { digest: Digest },
  { httpApiStatus: 404 }
) {}

export class DeviceActionInvalid extends schemaTaggedError<DeviceActionInvalid>()(
  "DeviceActionInvalid",
  {},
  { httpApiStatus: 422 }
) {}

export class DeviceActionServiceUnavailable extends schemaTaggedError<DeviceActionServiceUnavailable>()(
  "DeviceActionServiceUnavailable",
  {},
  { httpApiStatus: 503 }
) {}

const DeviceActionErrors = [
  DeviceActionConflict,
  DeviceActionInvalid,
  DeviceActionNotFound,
  DeviceActionServiceUnavailable,
] as const;

export class DeviceActionsApiGroup extends HttpApiGroup.make("device-actions")
  .add(
    HttpApiEndpoint.post("submit", "/", {
      error: DeviceActionErrors,
      payload: SubmitDeviceActionPayload,
      success: SubmittedDeviceActionResponse,
    }),
    HttpApiEndpoint.get("get", "/:digest", {
      error: DeviceActionErrors,
      params: { digest: DigestInput },
      success: ReconciledDeviceActionResponse,
    })
  )
  .prefix("/v1/device-actions")
  .annotateMerge(
    OpenApi.annotations({
      description:
        "Submit and reconcile owner-signed add/remove device actions.",
      title: "Device actions",
    })
  ) {}
