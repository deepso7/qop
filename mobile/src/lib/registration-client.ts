import {
  EcdsaSignature,
  Hex32,
  IdentityEip712DomainV1,
  Qid,
  RegisterIntentV1,
} from "@qop/identity";
import { Data, Effect, Schema } from "effect";
import { fetch } from "expo/fetch";

const CanonicalHex32 = Hex32.pipe(Schema.decodeTo(Hex32.pipe(Schema.flip)));
const CanonicalQid = Qid.pipe(Schema.decodeTo(Qid.pipe(Schema.flip)));
const CanonicalDomain = IdentityEip712DomainV1.pipe(
  Schema.decodeTo(IdentityEip712DomainV1.pipe(Schema.flip))
);
const CanonicalRegisterIntent = RegisterIntentV1.pipe(
  Schema.decodeTo(RegisterIntentV1.pipe(Schema.flip))
);
const CanonicalSignature = EcdsaSignature.pipe(
  Schema.decodeTo(EcdsaSignature.pipe(Schema.flip))
);

const PreparedRegistrationResponse = Schema.Struct({
  digest: CanonicalHex32,
  domain: CanonicalDomain,
  intent: CanonicalRegisterIntent,
  status: Schema.Literal("pending_owner_signature"),
});

const AuthorizedRegistrationResponse = Schema.Struct({
  digest: CanonicalHex32,
  intent: CanonicalRegisterIntent,
  ownerSignature: CanonicalSignature,
  registrationSignature: CanonicalSignature,
  status: Schema.Literals(["confirmed", "ready", "submitted"]),
});

const ReconciledRegistrationResponse = Schema.Struct({
  digest: CanonicalHex32,
  failureCode: Schema.NullOr(Schema.String),
  qid: Schema.NullOr(CanonicalQid),
  status: Schema.Literals([
    "pending_owner_signature",
    "ready",
    "submitted",
    "confirmed",
    "failed",
    "expired",
  ]),
});

const ErrorResponse = Schema.Struct({
  _tag: Schema.String,
  kind: Schema.optionalKey(Schema.String),
});

export type PreparedRegistration = typeof PreparedRegistrationResponse.Type;
export type AuthorizedRegistration = typeof AuthorizedRegistrationResponse.Type;
export type ReconciledRegistration = typeof ReconciledRegistrationResponse.Type;

export interface PrepareRegistrationInput {
  readonly admissionCode: string;
  readonly deviceCommitment: string;
  readonly handle: string;
  readonly idempotencyKey: string;
  readonly observeTokenHash: string;
  readonly owner: string;
  readonly peerId: string;
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

const expectedDomain = Effect.fn("RegistrationClient.expectedDomain")(
  function* () {
    const chainId = process.env.EXPO_PUBLIC_REGISTRY_CHAIN_ID;
    const verifyingContract = process.env.EXPO_PUBLIC_REGISTRY_ADDRESS;
    if (!chainId || !verifyingContract) {
      return yield* clientError("configuration");
    }
    return yield* Schema.decodeUnknownEffect(CanonicalDomain)({
      chainId,
      verifyingContract: verifyingContract.toLowerCase(),
    }).pipe(Effect.mapError(() => clientError("configuration")));
  }
);

const post = Effect.fn("RegistrationClient.post")(function* (
  path: string,
  payload?: unknown
) {
  const baseUrl = yield* apiUrl();
  const response = yield* Effect.tryPromise({
    catch: () => clientError("network"),
    try: () =>
      fetch(new URL(path, baseUrl), {
        body: payload === undefined ? undefined : JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
  });
  const body = yield* Effect.tryPromise({
    catch: () => clientError("response", response.status),
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

export const prepareRegistration = Effect.fn(
  "RegistrationClient.prepareRegistration"
)(function* (input: PrepareRegistrationInput) {
  const [{ body, status }, configuredDomain] = yield* Effect.all(
    [post("/v1/registrations", input), expectedDomain()] as const,
    { concurrency: "unbounded" }
  );
  const prepared = yield* Schema.decodeUnknownEffect(
    PreparedRegistrationResponse
  )(body).pipe(Effect.mapError(() => clientError("response", status)));
  if (
    prepared.domain.chainId !== configuredDomain.chainId ||
    prepared.domain.verifyingContract !== configuredDomain.verifyingContract
  ) {
    return yield* clientError("response", status);
  }
  return prepared;
});

export const authorizeRegistration = Effect.fn(
  "RegistrationClient.authorizeRegistration"
)((digest: string, ownerSignature: string) =>
  post(`/v1/registrations/${encodeURIComponent(digest)}/authorize`, {
    ownerSignature,
  }).pipe(
    Effect.flatMap(({ body, status }) =>
      Schema.decodeUnknownEffect(AuthorizedRegistrationResponse)(body).pipe(
        Effect.mapError(() => clientError("response", status))
      )
    )
  )
);

export const reconcileRegistration = Effect.fn(
  "RegistrationClient.reconcileRegistration"
)((digest: string) =>
  post(`/v1/registrations/${encodeURIComponent(digest)}/reconcile`).pipe(
    Effect.flatMap(({ body, status }) =>
      Schema.decodeUnknownEffect(ReconciledRegistrationResponse)(body).pipe(
        Effect.mapError(() => clientError("response", status))
      )
    )
  )
);
