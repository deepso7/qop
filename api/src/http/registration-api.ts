import {
  Base64Url32,
  DeviceCommitment,
  EcdsaSignature,
  Handle,
  Hex32,
  IdentityEip712DomainV1,
  PeerId,
  Qid,
  RegisterIntentV1,
  RegistrationAdmissionCode,
} from "@qop/identity";
import { Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";

import { registrationIntentStatuses } from "../registration/types.ts";

const Digest = Hex32.pipe(Schema.decodeTo(Hex32.pipe(Schema.flip)));
const PeerIdString = PeerId.pipe(Schema.decodeTo(PeerId.pipe(Schema.flip)));
const CanonicalSignature = EcdsaSignature.pipe(
  Schema.decodeTo(EcdsaSignature.pipe(Schema.flip))
);
const CanonicalQid = Qid.pipe(Schema.decodeTo(Qid.pipe(Schema.flip)));
const CanonicalBase64Url32 = Base64Url32.pipe(
  Schema.decodeTo(Base64Url32.pipe(Schema.flip))
);
const CanonicalAdmissionCode = RegistrationAdmissionCode.pipe(
  Schema.decodeTo(RegistrationAdmissionCode.pipe(Schema.flip))
);
const CanonicalDeviceCommitment = DeviceCommitment.pipe(
  Schema.decodeTo(DeviceCommitment.pipe(Schema.flip))
);
const CanonicalRegisterIntent = RegisterIntentV1.pipe(
  Schema.decodeTo(RegisterIntentV1.pipe(Schema.flip))
);
const CanonicalIdentityDomain = IdentityEip712DomainV1.pipe(
  Schema.decodeTo(IdentityEip712DomainV1.pipe(Schema.flip))
);

const AddressInput = Schema.String.check(
  Schema.isPattern(/^0x[0-9a-f]{40}$/iu, {
    expected: "a 20-byte 0x-prefixed Ethereum address",
  })
);

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

export const PrepareRegistrationPayload = Schema.Struct({
  admissionCode: CanonicalAdmissionCode,
  deviceCommitment: CanonicalDeviceCommitment,
  handle: Handle,
  idempotencyKey: CanonicalBase64Url32,
  observeTokenHash: DigestInput,
  owner: AddressInput,
  peerId: PeerIdString,
});

export const AuthorizeRegistrationPayload = Schema.Struct({
  ownerSignature: WalletSignatureInput,
});

export const PreparedRegistrationResponse = Schema.Struct({
  digest: Digest,
  domain: CanonicalIdentityDomain,
  intent: CanonicalRegisterIntent,
  status: Schema.Literal("pending_owner_signature"),
});

export const AuthorizedRegistrationResponse = Schema.Struct({
  digest: Digest,
  intent: CanonicalRegisterIntent,
  ownerSignature: CanonicalSignature,
  registrationSignature: CanonicalSignature,
  status: Schema.Literals(["confirmed", "ready", "submitted"]),
});

export const ReconciledRegistrationResponse = Schema.Struct({
  digest: Digest,
  failureCode: Schema.NullOr(Schema.String),
  qid: Schema.NullOr(CanonicalQid),
  status: Schema.Literals(registrationIntentStatuses),
});

export class RegistrationConflict extends Schema.TaggedErrorClass<RegistrationConflict>()(
  "RegistrationConflict",
  {
    actual: Schema.optionalKey(Schema.Literals(registrationIntentStatuses)),
    kind: Schema.Literals([
      "handle-unavailable",
      "admission-draft-limit",
      "draft-limit",
      "intent-conflict",
      "lease-conflict",
      "owner-unavailable",
      "transition-conflict",
    ]),
    qid: Schema.optionalKey(CanonicalQid),
  },
  { httpApiStatus: 409 }
) {}

export class RegistrationExpired extends Schema.TaggedErrorClass<RegistrationExpired>()(
  "RegistrationExpired",
  { digest: Digest },
  { httpApiStatus: 410 }
) {}

export class RegistrationNotFound extends Schema.TaggedErrorClass<RegistrationNotFound>()(
  "RegistrationNotFound",
  { digest: Digest },
  { httpApiStatus: 404 }
) {}

export class RegistrationUnauthorized extends Schema.TaggedErrorClass<RegistrationUnauthorized>()(
  "RegistrationUnauthorized",
  {},
  { httpApiStatus: 401 }
) {}

export class RegistrationInvalid extends Schema.TaggedErrorClass<RegistrationInvalid>()(
  "RegistrationInvalid",
  {},
  { httpApiStatus: 422 }
) {}

export class RegistrationServiceUnavailable extends Schema.TaggedErrorClass<RegistrationServiceUnavailable>()(
  "RegistrationServiceUnavailable",
  {},
  { httpApiStatus: 503 }
) {}

const RegistrationErrors = [
  RegistrationConflict,
  RegistrationExpired,
  RegistrationInvalid,
  RegistrationNotFound,
  RegistrationServiceUnavailable,
  RegistrationUnauthorized,
] as const;

export class RegistrationApiGroup extends HttpApiGroup.make("registrations")
  .add(
    HttpApiEndpoint.post("prepare", "/", {
      error: RegistrationErrors,
      payload: PrepareRegistrationPayload,
      success: PreparedRegistrationResponse,
    }),
    HttpApiEndpoint.post("authorize", "/:digest/authorize", {
      error: RegistrationErrors,
      params: { digest: DigestInput },
      payload: AuthorizeRegistrationPayload,
      success: AuthorizedRegistrationResponse,
    }),
    HttpApiEndpoint.post("reconcile", "/:digest/reconcile", {
      error: RegistrationErrors,
      params: { digest: DigestInput },
      success: ReconciledRegistrationResponse,
    })
  )
  .prefix("/v1/registrations")
  .annotateMerge(
    OpenApi.annotations({
      description: "Prepare, authorize, and reconcile identity registrations.",
      title: "Registrations",
    })
  ) {}
