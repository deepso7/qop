import {
  EcdsaSignature,
  Hex32,
  Qid,
  RegisterIntentV1,
  RegistrationAdmissionCode,
} from "@qop/identity";
import type { RegisterIntentV1Encoded } from "@qop/identity";
import { Data, Effect, Schema } from "effect";
import { recoverAddress } from "viem";
import type { Hex } from "viem";

const CanonicalHex32 = Hex32.pipe(Schema.decodeTo(Hex32.pipe(Schema.flip)));
const CanonicalQid = Qid.pipe(Schema.decodeTo(Qid.pipe(Schema.flip)));
const CanonicalSignature = EcdsaSignature.pipe(
  Schema.decodeTo(EcdsaSignature.pipe(Schema.flip))
);
const CanonicalAdmissionCode = RegistrationAdmissionCode.pipe(
  Schema.decodeTo(RegistrationAdmissionCode.pipe(Schema.flip))
);
const WalletSignatureInput = Schema.String.check(
  Schema.isPattern(/^0x[0-9a-f]{128}(?:00|01|1b|1c)$/iu)
);
const CanonicalRegisterIntent = RegisterIntentV1.pipe(
  Schema.decodeTo(RegisterIntentV1.pipe(Schema.flip))
);

const RegisteredRegistrationResponse = Schema.Struct({
  digest: CanonicalHex32,
  registrationSignature: CanonicalSignature,
  status: Schema.Literals(["submitted", "confirmed"]),
  transactionHash: CanonicalHex32,
});

const RegistrationResponseBase = {
  digest: CanonicalHex32,
  transactionHash: Schema.NullOr(CanonicalHex32),
} as const;

const RegistrationResponse = Schema.Union([
  Schema.Struct({
    ...RegistrationResponseBase,
    failureCode: Schema.Null,
    qid: Schema.Null,
    status: Schema.Literals(["ready", "submitted"]),
  }),
  Schema.Struct({
    ...RegistrationResponseBase,
    failureCode: Schema.Null,
    qid: CanonicalQid,
    status: Schema.Literal("confirmed"),
  }),
  Schema.Struct({
    ...RegistrationResponseBase,
    failureCode: Schema.String,
    qid: Schema.Null,
    status: Schema.Literal("failed"),
  }),
]);

const ErrorResponse = Schema.Struct({
  _tag: Schema.String,
  kind: Schema.optionalKey(Schema.String),
});

export type RegisteredRegistration = typeof RegisteredRegistrationResponse.Type;
export type Registration = typeof RegistrationResponse.Type;

export interface RegisterInput {
  readonly admissionCode: string;
  readonly intent: RegisterIntentV1Encoded;
  readonly ownerSignature: string;
}

export interface RegistrationClientDependencies {
  readonly fetch: (input: URL, init?: RequestInit) => Promise<Response>;
}

export class RegistrationClientError extends Data.TaggedError(
  "RegistrationClientError"
)<{
  readonly kind: string | null;
  readonly operation: "configuration" | "network" | "response";
  readonly status: number | null;
  readonly tag: string | null;
}> {}

const clientError = (
  operation: RegistrationClientError["operation"],
  status: number | null = null,
  tag: string | null = null,
  kind: string | null = null
) => new RegistrationClientError({ kind, operation, status, tag });

const apiUrl = Effect.fn("RegistrationClient.apiUrl")(function* () {
  const configured = process.env.EXPO_PUBLIC_API_URL;
  if (!configured) {
    return yield* clientError("configuration");
  }
  return yield* Schema.decodeUnknownEffect(Schema.URLFromString)(
    configured
  ).pipe(Effect.mapError(() => clientError("configuration")));
});

export const createRegistrationClient = ({
  fetch,
}: RegistrationClientDependencies) => {
  const request = Effect.fn("RegistrationClient.request")(function* (
    path: string,
    init?: RequestInit
  ) {
    const baseUrl = yield* apiUrl();
    const response = yield* Effect.tryPromise({
      catch: () => clientError("network"),
      try: () => fetch(new URL(path, baseUrl), init),
    });
    const body = yield* Effect.tryPromise({
      catch: () => clientError("response", response.status),
      // SAFETY: The response JSON is decoded immediately below.
      try: () => response.json() as Promise<unknown>,
    });
    if (!response.ok) {
      const decoded = Schema.decodeUnknownResult(ErrorResponse)(body);
      return yield* clientError(
        "response",
        response.status,
        decoded._tag === "Success" ? decoded.success._tag : null,
        decoded._tag === "Success" ? (decoded.success.kind ?? null) : null
      );
    }
    return { body, status: response.status };
  });

  const register = Effect.fn("RegistrationClient.register")(function* (
    input: RegisterInput
  ) {
    const payload = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        admissionCode: CanonicalAdmissionCode,
        intent: CanonicalRegisterIntent,
        ownerSignature: WalletSignatureInput,
      })
    )(input).pipe(Effect.mapError(() => clientError("response")));
    const { body, status } = yield* request("/v1/registrations", {
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const registered = yield* Schema.decodeUnknownEffect(
      RegisteredRegistrationResponse
    )(body).pipe(Effect.mapError(() => clientError("response", status)));
    const recovered = yield* Effect.tryPromise({
      catch: () => clientError("response", status),
      // SAFETY: The response schemas validated both values as canonical hex.
      try: () =>
        recoverAddress({
          hash: registered.digest as Hex,
          signature: registered.registrationSignature as Hex,
        }),
    });
    if (recovered.toLowerCase() === `0x${"00".repeat(20)}`) {
      return yield* clientError("response", status);
    }
    return registered;
  });

  const getRegistration = Effect.fn("RegistrationClient.getRegistration")(
    (digest: string) =>
      Schema.decodeUnknownEffect(CanonicalHex32)(digest).pipe(
        Effect.mapError(() => clientError("response")),
        Effect.flatMap((canonicalDigest) =>
          request(`/v1/registrations/${encodeURIComponent(canonicalDigest)}`)
        ),
        Effect.flatMap(({ body, status }) =>
          Schema.decodeUnknownEffect(RegistrationResponse)(body).pipe(
            Effect.mapError(() => clientError("response", status))
          )
        )
      )
  );

  return { getRegistration, register };
};
