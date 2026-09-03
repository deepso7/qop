import { Data, Effect, Schema } from "effect";

import { strictParseOptions } from "./internal.ts";
import { ChainId, EthereumAddress } from "./wire-codecs.ts";

export const identityEip712DomainName = "QOP Identity" as const;
// This must match the immutable version passed to the deployed registry's
// EIP712 constructor. Wire-schema versions evolve independently.
export const identityEip712DomainVersion = "1" as const;

// oxlint-disable-next-line no-redeclare -- The schema and its inferred type intentionally share the public API name.
export const IdentityEip712DomainV1 = Schema.Struct({
  chainId: ChainId,
  verifyingContract: EthereumAddress,
}).annotate({
  messageUnexpectedKey: "Unexpected identity EIP-712 domain field",
  parseOptions: strictParseOptions,
});

export type IdentityEip712DomainV1 = typeof IdentityEip712DomainV1.Type;
export type IdentityEip712DomainV1Encoded =
  typeof IdentityEip712DomainV1.Encoded;

export class IdentityCryptoError extends Data.TaggedError(
  "IdentityCryptoError"
)<{
  readonly cause: unknown;
  readonly operation:
    | "hash-register-intent"
    | "hash-rotate-device-intent"
    | "hash-rotate-owner-intent"
    | "recover-register-intent-signer"
    | "recover-rotate-device-intent-signer"
    | "recover-rotate-owner-intent-signer"
    | "sign-register-intent";
}> {}

export const decodeIdentityEip712DomainV1 = Effect.fn(
  "@qop/identity/decodeIdentityEip712DomainV1"
)((input: IdentityEip712DomainV1Encoded) =>
  Schema.decodeEffect(IdentityEip712DomainV1)(input)
);
