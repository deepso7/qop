import { Data, Effect, Schema } from "effect";

import { strictParseOptions } from "./internal.ts";
import { ChainId, EthereumAddress } from "./wire-codecs.ts";

export const identityEip712DomainName = "QOP Identity" as const;
// This must match the immutable version passed to the deployed registry's
// EIP712 constructor. Wire-schema versions evolve independently.
export const identityEip712DomainVersion = "1" as const;

const IdentityEip712DomainV1Schema = Schema.Struct({
  chainId: ChainId,
  verifyingContract: EthereumAddress,
}).annotate({
  messageUnexpectedKey: "Unexpected identity EIP-712 domain field",
  parseOptions: strictParseOptions,
});
export { IdentityEip712DomainV1Schema as IdentityEip712DomainV1 };
export type IdentityEip712DomainV1 = typeof IdentityEip712DomainV1Schema.Type;
export type IdentityEip712DomainV1Encoded =
  typeof IdentityEip712DomainV1Schema.Encoded;

export class IdentityCryptoError extends Data.TaggedError(
  "IdentityCryptoError"
)<{
  readonly cause: unknown;
  readonly operation:
    | "hash-add-device-intent"
    | "hash-register-intent"
    | "hash-remove-device-intent"
    | "hash-rotate-owner-intent"
    | "hash-wipe-devices-intent"
    | "recover-add-device-intent-signer"
    | "recover-register-intent-signer"
    | "recover-remove-device-intent-signer"
    | "recover-rotate-owner-intent-signer"
    | "recover-wipe-devices-intent-signer"
    | "sign-register-intent";
}> {}

export const decodeIdentityEip712DomainV1 = Effect.fn(
  "@qop/identity/decodeIdentityEip712DomainV1"
)((input: IdentityEip712DomainV1Encoded) =>
  Schema.decodeEffect(IdentityEip712DomainV1Schema)(input)
);
