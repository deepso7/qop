import {
  Base64Url32,
  DeviceCommitment,
  EcdsaSignature,
  Handle,
  Hex32,
  normalizeEcdsaSignature,
  normalizeEthereumAddress,
  PeerId,
  Qid,
  RegistrationNonce,
  UnixSeconds,
} from "@qop/identity";
import { Data, Effect, Schema } from "effect";
import type { Address, Hash, Hex } from "viem";

import type {
  CreateRegistrationIntent,
  RegistrationAuthorization,
} from "./types.ts";

type RegistrationInputField =
  | "admission-code"
  | "admission-code-hash"
  | "deadline"
  | "device-commitment"
  | "digest"
  | "handle"
  | "idempotency-key-hash"
  | "idempotency-key"
  | "observe-token-hash"
  | "owner"
  | "owner-signature"
  | "peer-id"
  | "qid"
  | "registration-nonce"
  | "registration-signature"
  | "transaction-hash";

export class RegistrationInputError extends Data.TaggedError(
  "RegistrationInputError"
)<{
  readonly cause: unknown;
  readonly field: RegistrationInputField;
}> {}

const inputError =
  (field: RegistrationInputField) =>
  (cause: unknown): RegistrationInputError =>
    new RegistrationInputError({ cause, field });

export const registrationAdmissionCodeInputError = inputError("admission-code");

const normalizeHex32 = Effect.fn("RegistrationInput.normalizeHex32")(function* (
  input: unknown,
  field: RegistrationInputField
) {
  const value = yield* Schema.decodeUnknownEffect(Schema.String)(input).pipe(
    Effect.mapError(inputError(field))
  );
  const bytes = yield* Schema.decodeUnknownEffect(Hex32)(
    value.toLowerCase()
  ).pipe(Effect.mapError(inputError(field)));
  return (yield* Schema.encodeEffect(Hex32)(bytes).pipe(
    Effect.mapError(inputError(field))
  )) as Hash;
});

export const normalizeRegistrationPeerId = Effect.fn(
  "RegistrationInput.normalizePeerId"
)(function* (input: unknown) {
  const bytes = yield* Schema.decodeUnknownEffect(PeerId)(input).pipe(
    Effect.mapError(inputError("peer-id"))
  );
  return yield* Schema.encodeEffect(PeerId)(bytes).pipe(
    Effect.mapError(inputError("peer-id"))
  );
});

export const normalizeRegistrationOwner = Effect.fn(
  "RegistrationInput.normalizeOwner"
)(function* (input: unknown) {
  const owner = yield* normalizeEthereumAddress(input).pipe(
    Effect.mapError(inputError("owner"))
  );
  if (owner === `0x${"00".repeat(20)}`) {
    return yield* new RegistrationInputError({
      cause: "Expected a non-zero Ethereum address",
      field: "owner",
    });
  }
  return owner as Address;
});

export const decodeRegistrationIdempotencyKey = Effect.fn(
  "RegistrationInput.decodeIdempotencyKey"
)(function* (input: unknown) {
  return yield* Schema.decodeUnknownEffect(Base64Url32)(input).pipe(
    Effect.mapError(inputError("idempotency-key"))
  );
});

const normalizeRegistrationNonce = Effect.fn(
  "RegistrationInput.normalizeRegistrationNonce"
)(function* (input: unknown) {
  const value = yield* Schema.decodeUnknownEffect(Schema.String)(input).pipe(
    Effect.mapError(inputError("registration-nonce"))
  );
  const bytes = yield* Schema.decodeUnknownEffect(RegistrationNonce)(
    value.toLowerCase()
  ).pipe(Effect.mapError(inputError("registration-nonce")));
  return (yield* Schema.encodeEffect(RegistrationNonce)(bytes).pipe(
    Effect.mapError(inputError("registration-nonce"))
  )) as Hash;
});

const normalizeSignature = Effect.fn("RegistrationInput.normalizeSignature")(
  function* (input: unknown, field: RegistrationInputField) {
    const bytes = yield* normalizeEcdsaSignature(input).pipe(
      Effect.mapError(inputError(field))
    );
    return (yield* Schema.encodeEffect(EcdsaSignature)(bytes).pipe(
      Effect.mapError(inputError(field))
    )) as Hex;
  }
);

export const normalizeDeviceCommitment = Effect.fn(
  "RegistrationInput.normalizeDeviceCommitment"
)(function* (input: unknown) {
  const value = yield* Schema.decodeUnknownEffect(Schema.String)(input).pipe(
    Effect.mapError(inputError("device-commitment"))
  );
  const bytes = yield* Schema.decodeUnknownEffect(DeviceCommitment)(
    value.toLowerCase()
  ).pipe(Effect.mapError(inputError("device-commitment")));
  return (yield* Schema.encodeEffect(DeviceCommitment)(bytes).pipe(
    Effect.mapError(inputError("device-commitment"))
  )) as Hash;
});

export const normalizeRegistrationOwnerSignature = Effect.fn(
  "RegistrationInput.normalizeOwnerSignature"
)((input: unknown) => normalizeSignature(input, "owner-signature"));

export const normalizeRegistrationSignerSignature = Effect.fn(
  "RegistrationInput.normalizeSignerSignature"
)((input: unknown) => normalizeSignature(input, "registration-signature"));

export const normalizeRegistrationDigest = Effect.fn(
  "RegistrationInput.normalizeDigest"
)((input: unknown) => normalizeHex32(input, "digest"));

export const normalizeRegistrationObserveTokenHash = Effect.fn(
  "RegistrationInput.normalizeObserveTokenHash"
)((input: unknown) => normalizeHex32(input, "observe-token-hash"));

export const normalizeRegistrationIdempotencyKeyHash = Effect.fn(
  "RegistrationInput.normalizeIdempotencyKeyHash"
)((input: unknown) => normalizeHex32(input, "idempotency-key-hash"));

export const normalizeTransactionHash = Effect.fn(
  "RegistrationInput.normalizeTransactionHash"
)((input: unknown) => normalizeHex32(input, "transaction-hash"));

export const normalizeRegistrationAuthorization = Effect.fn(
  "RegistrationInput.normalizeAuthorization"
)(function* (
  input: RegistrationAuthorization
): Effect.fn.Return<RegistrationAuthorization, RegistrationInputError> {
  return {
    ownerSignature: yield* normalizeRegistrationOwnerSignature(
      input.ownerSignature
    ),
    registrationSignature: yield* normalizeRegistrationSignerSignature(
      input.registrationSignature
    ),
  };
});

export const normalizeCreateRegistrationIntent = Effect.fn(
  "RegistrationInput.normalizeCreateIntent"
)(function* (
  input: CreateRegistrationIntent
): Effect.fn.Return<CreateRegistrationIntent, RegistrationInputError> {
  yield* Schema.encodeEffect(UnixSeconds)(input.deadline).pipe(
    Effect.mapError(inputError("deadline"))
  );
  const handle = yield* Schema.decodeUnknownEffect(Handle)(input.handle).pipe(
    Effect.mapError(inputError("handle"))
  );
  const owner = yield* normalizeRegistrationOwner(input.owner);

  return {
    admissionCodeHash: yield* normalizeHex32(
      input.admissionCodeHash,
      "admission-code-hash"
    ),
    deadline: input.deadline,
    deviceCommitment: yield* normalizeDeviceCommitment(input.deviceCommitment),
    digest: yield* normalizeRegistrationDigest(input.digest),
    handle,
    idempotencyKeyHash: yield* normalizeRegistrationIdempotencyKeyHash(
      input.idempotencyKeyHash
    ),
    observeTokenHash: yield* normalizeRegistrationObserveTokenHash(
      input.observeTokenHash
    ),
    owner: owner as Address,
    peerId: yield* normalizeRegistrationPeerId(input.peerId),
    registrationNonce: yield* normalizeRegistrationNonce(
      input.registrationNonce
    ),
  };
});

export const normalizeRegistrationQid = Effect.fn(
  "RegistrationInput.normalizeQid"
)(function* (qid: bigint) {
  yield* Schema.encodeEffect(Qid)(qid).pipe(Effect.mapError(inputError("qid")));
  return qid;
});
