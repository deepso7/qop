import {
  DeviceKey,
  EcdsaSignature,
  Handle,
  Hex32,
  normalizeEcdsaSignature,
  normalizeEthereumAddress,
  Qid,
  RegistrationNonce,
  UnixSeconds,
} from "@qop/identity";
import { Data, Effect, Schema } from "effect";
import { isAddress, isHash, isHex } from "viem";

import type { CreateRegistrationIntent } from "./types.ts";

type RegistrationInputField =
  | "admission-code"
  | "admission-code-hash"
  | "deadline"
  | "device-key"
  | "digest"
  | "handle"
  | "owner"
  | "owner-signature"
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

const normalizeHex32 = Effect.fn("RegistrationInput.normalizeHex32")(function* (
  input: string,
  field: RegistrationInputField
) {
  const bytes = yield* Schema.decodeUnknownEffect(Hex32)(
    input.toLowerCase()
  ).pipe(Effect.mapError(inputError(field)));
  return yield* Schema.encodeEffect(Hex32)(bytes).pipe(
    Effect.mapError(inputError(field)),
    Effect.flatMap((encoded) => hashFrom(encoded, field))
  );
});

export const normalizeRegistrationOwner = Effect.fn(
  "RegistrationInput.normalizeOwner"
)(function* (input: string) {
  const owner = yield* normalizeEthereumAddress(input).pipe(
    Effect.mapError(inputError("owner"))
  );
  if (!isAddress(owner) || owner === `0x${"00".repeat(20)}`) {
    return yield* inputError("owner")("Expected a non-zero Ethereum address");
  }
  return owner;
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

export const normalizeRegistrationOwnerSignature = Effect.fn(
  "RegistrationInput.normalizeOwnerSignature"
)((input: string) => normalizeSignature(input, "owner-signature"));

export const normalizeRegistrationSignerSignature = Effect.fn(
  "RegistrationInput.normalizeSignerSignature"
)((input: string) => normalizeSignature(input, "registration-signature"));

export const normalizeRegistrationDigest = Effect.fn(
  "RegistrationInput.normalizeDigest"
)((input: string) => normalizeHex32(input, "digest"));

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

export const normalizeCreateRegistrationIntent = Effect.fn(
  "RegistrationInput.normalizeCreateIntent"
)(function* (input: CreateRegistrationIntent) {
  yield* Schema.encodeEffect(UnixSeconds)(input.deadline).pipe(
    Effect.mapError(inputError("deadline"))
  );
  const handle = yield* Schema.decodeUnknownEffect(Handle)(input.handle).pipe(
    Effect.mapError(inputError("handle"))
  );
  const deviceKeyBytes = yield* Schema.decodeUnknownEffect(DeviceKey)(
    input.deviceKey.toLowerCase()
  ).pipe(Effect.mapError(inputError("device-key")));
  const deviceKey = yield* Schema.encodeEffect(DeviceKey)(deviceKeyBytes).pipe(
    Effect.mapError(inputError("device-key")),
    Effect.flatMap((encoded) => hashFrom(encoded, "device-key"))
  );
  const nonceBytes = yield* Schema.decodeUnknownEffect(RegistrationNonce)(
    input.registrationNonce.toLowerCase()
  ).pipe(Effect.mapError(inputError("registration-nonce")));
  const registrationNonce = yield* Schema.encodeEffect(RegistrationNonce)(
    nonceBytes
  ).pipe(
    Effect.mapError(inputError("registration-nonce")),
    Effect.flatMap((encoded) => hashFrom(encoded, "registration-nonce"))
  );

  return {
    admissionCodeHash: yield* normalizeHex32(
      input.admissionCodeHash,
      "admission-code-hash"
    ),
    deadline: input.deadline,
    deviceKey,
    digest: yield* normalizeRegistrationDigest(input.digest),
    handle,
    owner: yield* normalizeRegistrationOwner(input.owner),
    ownerSignature: yield* normalizeRegistrationOwnerSignature(
      input.ownerSignature
    ),
    registrationNonce,
    registrationSignature: yield* normalizeRegistrationSignerSignature(
      input.registrationSignature
    ),
  } satisfies CreateRegistrationIntent;
});

export const normalizeRegistrationQid = Effect.fn(
  "RegistrationInput.normalizeQid"
)(function* (qid: bigint) {
  yield* Schema.encodeEffect(Qid)(qid).pipe(Effect.mapError(inputError("qid")));
  return qid;
});
