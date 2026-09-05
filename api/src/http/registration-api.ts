import {
  EcdsaSignature,
  Hex32,
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

const canonical = <S extends Schema.Top>(schema: S) =>
  schema.pipe(Schema.decodeTo(schema.pipe(Schema.flip)));

const Digest = canonical(Hex32);
const CanonicalSignature = canonical(EcdsaSignature);
const CanonicalQid = canonical(Qid);
const CanonicalAdmissionCode = canonical(RegistrationAdmissionCode);
const CanonicalRegisterIntent = canonical(RegisterIntentV1);

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

export const RegisterRegistrationPayload = Schema.Struct({
  admissionCode: CanonicalAdmissionCode,
  intent: CanonicalRegisterIntent,
  ownerSignature: WalletSignatureInput,
});

export const RegisteredRegistrationResponse = Schema.Struct({
  digest: Digest,
  registrationSignature: CanonicalSignature,
  status: Schema.Literals(["submitted", "confirmed"]),
  transactionHash: Digest,
});

export const ReconciledRegistrationResponse = Schema.Struct({
  digest: Digest,
  failureCode: Schema.NullOr(Schema.String),
  qid: Schema.NullOr(CanonicalQid),
  status: Schema.Literals(registrationIntentStatuses),
  transactionHash: Schema.NullOr(Digest),
});

export class RegistrationConflict extends Schema.TaggedErrorClass<RegistrationConflict>()(
  "RegistrationConflict",
  {
    actual: Schema.optionalKey(Schema.Literals(registrationIntentStatuses)),
    kind: Schema.Literals([
      "handle-unavailable",
      "nonce-used",
      "owner-unavailable",
      "transition-conflict",
    ]),
    qid: Schema.optionalKey(CanonicalQid),
  },
  { httpApiStatus: 409 }
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
  RegistrationInvalid,
  RegistrationNotFound,
  RegistrationServiceUnavailable,
  RegistrationUnauthorized,
] as const;

export class RegistrationApiGroup extends HttpApiGroup.make("registrations")
  .add(
    HttpApiEndpoint.post("register", "/", {
      error: RegistrationErrors,
      payload: RegisterRegistrationPayload,
      success: RegisteredRegistrationResponse,
    }),
    HttpApiEndpoint.get("get", "/:digest", {
      error: RegistrationErrors,
      params: { digest: DigestInput },
      success: ReconciledRegistrationResponse,
    })
  )
  .prefix("/v1/registrations")
  .annotateMerge(
    OpenApi.annotations({
      description: "Submit and reconcile invitation-gated registrations.",
      title: "Registrations",
    })
  ) {}
