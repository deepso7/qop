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
import { isAddress, isHash, isHex } from "viem";

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
  | "serialized-transaction"
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

const hashFrom = (value: string, field: RegistrationInputField) =>
  isHash(value)
    ? Effect.succeed(value)
    : Effect.fail(inputError(field)("Expected a 0x-prefixed hexadecimal hash"));

const hexFrom = (value: string, field: RegistrationInputField) =>
  isHex(value)
    ? Effect.succeed(value)
    : Effect.fail(inputError(field)("Expected 0x-prefixed hexadecimal data"));

const addressFrom = (value: string, field: RegistrationInputField) =>
  isAddress(value)
    ? Effect.succeed(value)
    : Effect.fail(inputError(field)("Expected a 20-byte Ethereum address"));

const normalizeHex32 = Effect.fn("RegistrationInput.normalizeHex32")(function* (
  input: string,
  field: RegistrationInputField
) {
  const value = yield* Schema.decodeUnknownEffect(Schema.String)(input).pipe(
    Effect.mapError(inputError(field))
  );
  const bytes = yield* Schema.decodeUnknownEffect(Hex32)(
    value.toLowerCase()
  ).pipe(Effect.mapError(inputError(field)));
  return yield* Schema.encodeEffect(Hex32)(bytes).pipe(
    Effect.mapError(inputError(field)),
    Effect.flatMap((encoded) => hashFrom(encoded, field))
  );
});

export const normalizeRegistrationPeerId = Effect.fn(
  "RegistrationInput.normalizePeerId"
)(function* (input: string) {
  const bytes = yield* Schema.decodeUnknownEffect(PeerId)(input).pipe(
    Effect.mapError(inputError("peer-id"))
  );
  return yield* Schema.encodeEffect(PeerId)(bytes).pipe(
    Effect.mapError(inputError("peer-id"))
  );
});

export const normalizeRegistrationOwner = Effect.fn(
  "RegistrationInput.normalizeOwner"
)(function* (input: string) {
  const owner = yield* normalizeEthereumAddress(input).pipe(
    Effect.mapError(inputError("owner"))
  );
  if (owner === `0x${"00".repeat(20)}`) {
    return yield* new RegistrationInputError({
      cause: "Expected a non-zero Ethereum address",
      field: "owner",
    });
  }
  return yield* addressFrom(owner, "owner");
});

export const decodeRegistrationIdempotencyKey = Effect.fn(
  "RegistrationInput.decodeIdempotencyKey"
)(function* (input: string) {
  return yield* Schema.decodeUnknownEffect(Base64Url32)(input).pipe(
    Effect.mapError(inputError("idempotency-key"))
  );
});

const normalizeRegistrationNonce = Effect.fn(
  "RegistrationInput.normalizeRegistrationNonce"
)(function* (input: string) {
  const value = yield* Schema.decodeUnknownEffect(Schema.String)(input).pipe(
    Effect.mapError(inputError("registration-nonce"))
  );
  const bytes = yield* Schema.decodeUnknownEffect(RegistrationNonce)(
    value.toLowerCase()
  ).pipe(Effect.mapError(inputError("registration-nonce")));
  return yield* Schema.encodeEffect(RegistrationNonce)(bytes).pipe(
    Effect.mapError(inputError("registration-nonce")),
    Effect.flatMap((encoded) => hashFrom(encoded, "registration-nonce"))
  );
});

const normalizeSignature = Effect.fn("RegistrationInput.normalizeSignature")(
  function* (input: string, field: RegistrationInputField) {
    const bytes = yield* normalizeEcdsaSignature(input).pipe(
      Effect.mapError(inputError(field))
    );
    return yield* Schema.encodeEffect(EcdsaSignature)(bytes).pipe(
      Effect.mapError(inputError(field)),
      Effect.flatMap((encoded) => hexFrom(encoded, field))
    );
  }
);

export const normalizeDeviceCommitment = Effect.fn(
  "RegistrationInput.normalizeDeviceCommitment"
)(function* (input: string) {
  const value = yield* Schema.decodeUnknownEffect(Schema.String)(input).pipe(
    Effect.mapError(inputError("device-commitment"))
  );
  const bytes = yield* Schema.decodeUnknownEffect(DeviceCommitment)(
    value.toLowerCase()
  ).pipe(Effect.mapError(inputError("device-commitment")));
  return yield* Schema.encodeEffect(DeviceCommitment)(bytes).pipe(
    Effect.mapError(inputError("device-commitment")),
    Effect.flatMap((encoded) => hashFrom(encoded, "device-commitment"))
  );
});

export const normalizeRegistrationOwnerSignature = Effect.fn(
  "RegistrationInput.normalizeOwnerSignature"
)((input: string) => normalizeSignature(input, "owner-signature"));

export const normalizeRegistrationSignerSignature = Effect.fn(
  "RegistrationInput.normalizeSignerSignature"
)((input: string) => normalizeSignature(input, "registration-signature"));

export const normalizeRegistrationDigest = Effect.fn(
  "RegistrationInput.normalizeDigest"
)((input: string) => normalizeHex32(input, "digest"));

export const normalizeRegistrationObserveTokenHash = Effect.fn(
  "RegistrationInput.normalizeObserveTokenHash"
)((input: string) => normalizeHex32(input, "observe-token-hash"));

export const normalizeRegistrationIdempotencyKeyHash = Effect.fn(
  "RegistrationInput.normalizeIdempotencyKeyHash"
)((input: string) => normalizeHex32(input, "idempotency-key-hash"));

export const normalizeTransactionHash = Effect.fn(
  "RegistrationInput.normalizeTransactionHash"
)((input: string) => normalizeHex32(input, "transaction-hash"));

const SerializedTransaction = Schema.String.check(
  Schema.isPattern(/^0x[0-9a-f]+$/u, {
    expected: "a lowercase 0x-prefixed serialized transaction",
  })
);

export const normalizeSerializedTransaction = Effect.fn(
  "RegistrationInput.normalizeSerializedTransaction"
)(function* (input: string) {
  const serialized = yield* Schema.decodeUnknownEffect(SerializedTransaction)(
    input
  ).pipe(Effect.mapError(inputError("serialized-transaction")));
  return yield* hexFrom(serialized, "serialized-transaction");
});

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
    owner,
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
