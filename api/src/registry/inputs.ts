import {
  Handle,
  normalizeEthereumAddress,
  RegistrationNonce,
} from "@qop/identity";
import { Data, Effect, Schema } from "effect";
import { toHex } from "viem";
import type { Address } from "viem";

type RegistryInputOperation = "handle" | "owner" | "registration-nonce";

export class RegistryInputError extends Data.TaggedError("RegistryInputError")<{
  readonly cause: unknown;
  readonly operation: RegistryInputOperation;
}> {}

export const normalizeRegistryOwner = Effect.fn("RegistryInput.normalizeOwner")(
  function* (input: string) {
    const owner = yield* normalizeEthereumAddress(input).pipe(
      Effect.mapError(
        (cause) => new RegistryInputError({ cause, operation: "owner" })
      )
    );
    const canonicalOwner = owner.toLowerCase();
    // SAFETY: normalizeEthereumAddress accepts only 20-byte 0x-prefixed Ethereum addresses.
    return canonicalOwner as Address;
  }
);

export const normalizeRegistryHandle = Effect.fn(
  "RegistryInput.normalizeHandle"
)(function* (input: string) {
  return yield* Schema.decodeUnknownEffect(Handle)(input).pipe(
    Effect.mapError(
      (cause) => new RegistryInputError({ cause, operation: "handle" })
    )
  );
});

export const normalizeRegistryRegistrationNonce = Effect.fn(
  "RegistryInput.normalizeRegistrationNonce"
)(function* (input: string) {
  const encoded = yield* Schema.decodeUnknownEffect(Schema.String)(input).pipe(
    Effect.mapError(
      (cause) =>
        new RegistryInputError({ cause, operation: "registration-nonce" })
    )
  );
  const bytes = yield* Schema.decodeUnknownEffect(RegistrationNonce)(
    encoded.toLowerCase()
  ).pipe(
    Effect.mapError(
      (cause) =>
        new RegistryInputError({ cause, operation: "registration-nonce" })
    )
  );
  return toHex(bytes);
});
