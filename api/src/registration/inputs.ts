import {
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
  | "deadline"
  | "digest"
  | "handle"
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

const normalizePeerId = Effect.fn("RegistrationInput.normalizePeerId")(
  function* (input: unknown) {
    const bytes = yield* Schema.decodeUnknownEffect(PeerId)(input).pipe(
      Effect.mapError(inputError("peer-id"))
    );
    return yield* Schema.encodeEffect(PeerId)(bytes).pipe(
      Effect.mapError(inputError("peer-id"))
    );
  }
);

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

export const normalizeRegistrationDigest = Effect.fn(
  "RegistrationInput.normalizeDigest"
)((input: unknown) => normalizeHex32(input, "digest"));

export const normalizeTransactionHash = Effect.fn(
  "RegistrationInput.normalizeTransactionHash"
)((input: unknown) => normalizeHex32(input, "transaction-hash"));

export const normalizeRegistrationAuthorization = Effect.fn(
  "RegistrationInput.normalizeAuthorization"
)(function* (
  input: RegistrationAuthorization
): Effect.fn.Return<RegistrationAuthorization, RegistrationInputError> {
  return {
    ownerSignature: yield* normalizeSignature(
      input.ownerSignature,
      "owner-signature"
    ),
    registrationSignature: yield* normalizeSignature(
      input.registrationSignature,
      "registration-signature"
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
  const owner = yield* normalizeEthereumAddress(input.owner).pipe(
    Effect.mapError(inputError("owner"))
  );

  return {
    deadline: input.deadline,
    digest: yield* normalizeRegistrationDigest(input.digest),
    handle,
    observeTokenHash: yield* normalizeHex32(
      input.observeTokenHash,
      "observe-token-hash"
    ),
    owner: owner as Address,
    peerId: yield* normalizePeerId(input.peerId),
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
