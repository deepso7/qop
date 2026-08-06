import { Handle, Hex32, normalizeEthereumAddress } from "@qop/identity";
import { Data, Effect, Schema } from "effect";
import type { Address, Hash } from "viem";

type RegistryInputOperation = "certificate-digest" | "handle" | "owner";

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
  function* (input: unknown) {
    return (yield* normalizeEthereumAddress(input).pipe(
      Effect.mapError(
        (cause) => new RegistryInputError({ cause, operation: "owner" })
      )
    )) as Address;
  }
);

export const normalizeCertificateDigest = Effect.fn(
  "RegistryInput.normalizeCertificateDigest"
)(function* (input: unknown) {
  const encoded = yield* Schema.decodeUnknownEffect(CertificateDigestInput)(
    input
  ).pipe(
    Effect.mapError(
      (cause) =>
        new RegistryInputError({ cause, operation: "certificate-digest" })
    )
  );
  const canonical = encoded.toLowerCase();
  yield* Schema.decodeUnknownEffect(Hex32)(canonical).pipe(
    Effect.mapError(
      (cause) =>
        new RegistryInputError({ cause, operation: "certificate-digest" })
    )
  );
  return canonical as Hash;
});

export const normalizeRegistryHandle = Effect.fn(
  "RegistryInput.normalizeHandle"
)(function* (input: unknown) {
  return yield* Schema.decodeUnknownEffect(Handle)(input).pipe(
    Effect.mapError(
      (cause) => new RegistryInputError({ cause, operation: "handle" })
    )
  );
});
