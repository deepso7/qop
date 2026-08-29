import {
  Handle,
  Hex32,
  normalizeEthereumAddress,
  RegistrationNonce,
} from "@qop/identity";
import { Data, Effect, Schema } from "effect";
import { toHex } from "viem";
import type { Address } from "viem";

type RegistryInputOperation =
  | "certificate-digest"
  | "handle"
  | "owner"
  | "registration-nonce";

const CertificateDigestInput = Schema.String.check(
  Schema.isPattern(/^0x[0-9a-f]{64}$/iu, {
    expected: "a 32-byte 0x-prefixed certificate digest",
  })
);

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

export const normalizeCertificateDigest = Effect.fn(
  "RegistryInput.normalizeCertificateDigest"
)(function* (input: string) {
  const encoded = yield* Schema.decodeUnknownEffect(CertificateDigestInput)(
    input
  ).pipe(
    Effect.mapError(
      (cause) =>
        new RegistryInputError({ cause, operation: "certificate-digest" })
    )
  );
  const bytes = yield* Schema.decodeUnknownEffect(Hex32)(
    encoded.toLowerCase()
  ).pipe(
    Effect.mapError(
      (cause) =>
        new RegistryInputError({ cause, operation: "certificate-digest" })
    )
  );
  return toHex(bytes);
});

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
