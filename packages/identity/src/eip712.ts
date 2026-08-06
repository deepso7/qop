import { Data, Effect, Schema } from "effect";
import { hashTypedData, recoverTypedDataAddress, toHex } from "viem";
import type { Address, Signature } from "viem";

import { DeviceCertificateV1 } from "./device-certificate.ts";
import type { DeviceCertificateV1 as DeviceCertificate } from "./device-certificate.ts";
import { ChainId, EcdsaSignature, EthereumAddress } from "./wire-codecs.ts";

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

export const identityEip712DomainName = "QOP Identity" as const;
// This must match the immutable version passed to the deployed registry's
// EIP712 constructor. Wire-schema versions evolve independently.
export const identityEip712DomainVersion = "1" as const;

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

export const deviceCertificateEip712Types = {
  DeviceCertificateV1: [
    { name: "version", type: "uint8" },
    { name: "qid", type: "uint256" },
    { name: "ownerVersion", type: "uint32" },
    { name: "peerId", type: "bytes" },
    { name: "encryptionPublicKey", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

export const makeDeviceCertificateTypedDataV1 = (
  domain: IdentityEip712DomainV1,
  certificate: DeviceCertificate
) =>
  ({
    domain: {
      chainId: domain.chainId,
      name: identityEip712DomainName,
      verifyingContract: domain.verifyingContract as Address,
      version: identityEip712DomainVersion,
    },
    message: {
      encryptionPublicKey: toHex(certificate.encryptionPublicKey),
      issuedAt: certificate.issuedAt,
      ownerVersion: certificate.ownerVersion,
      peerId: toHex(certificate.peerId),
      qid: certificate.qid,
      salt: toHex(certificate.salt),
      version: certificate.version,
    },
    primaryType: "DeviceCertificateV1",
    types: deviceCertificateEip712Types,
  }) as const;

export class IdentityCryptoError extends Data.TaggedError(
  "IdentityCryptoError"
)<{
  readonly cause: unknown;
  readonly operation:
    | "hash-device-certificate"
    | "hash-register-intent"
    | "hash-revoke-device-intent"
    | "hash-rotate-owner-intent"
    | "recover-certificate-owner"
    | "recover-register-intent-signer"
    | "recover-revoke-device-intent-signer"
    | "recover-rotate-owner-intent-signer"
    | "verify-certificate-owner";
}> {}

const toViemSignature = (signature: Uint8Array): Signature => ({
  r: toHex(signature.subarray(0, 32)),
  s: toHex(signature.subarray(32, 64)),
  yParity: signature[64] as 0 | 1,
});

const validateCertificateInputs = (
  operation: IdentityCryptoError["operation"],
  domain: IdentityEip712DomainV1,
  certificate: DeviceCertificate
) =>
  Schema.encodeEffect(IdentityEip712DomainV1)(domain).pipe(
    Effect.andThen(Schema.encodeEffect(DeviceCertificateV1)(certificate)),
    Effect.mapError((cause) => new IdentityCryptoError({ cause, operation }))
  );

export const decodeIdentityEip712DomainV1 = Effect.fn(
  "@qop/identity/decodeIdentityEip712DomainV1"
)((input: unknown) =>
  Schema.decodeUnknownEffect(IdentityEip712DomainV1)(input)
);

export const encodeIdentityEip712DomainV1 = Effect.fn(
  "@qop/identity/encodeIdentityEip712DomainV1"
)((domain: IdentityEip712DomainV1) =>
  Schema.encodeEffect(IdentityEip712DomainV1)(domain)
);

export const hashDeviceCertificateV1 = Effect.fn(
  "@qop/identity/hashDeviceCertificateV1"
)((domain: IdentityEip712DomainV1, certificate: DeviceCertificate) =>
  validateCertificateInputs(
    "hash-device-certificate",
    domain,
    certificate
  ).pipe(
    Effect.andThen(
      Effect.try({
        catch: (cause) =>
          new IdentityCryptoError({
            cause,
            operation: "hash-device-certificate",
          }),
        try: () =>
          hashTypedData(makeDeviceCertificateTypedDataV1(domain, certificate)),
      })
    )
  )
);

export const recoverDeviceCertificateOwnerV1 = Effect.fn(
  "@qop/identity/recoverDeviceCertificateOwnerV1"
)(
  (
    domain: IdentityEip712DomainV1,
    certificate: DeviceCertificate,
    signature: Uint8Array
  ) =>
    validateCertificateInputs(
      "recover-certificate-owner",
      domain,
      certificate
    ).pipe(
      Effect.andThen(
        Schema.encodeEffect(EcdsaSignature)(signature).pipe(
          Effect.mapError(
            (cause) =>
              new IdentityCryptoError({
                cause,
                operation: "recover-certificate-owner",
              })
          )
        )
      ),
      Effect.flatMap(() =>
        Effect.tryPromise({
          catch: (cause) =>
            new IdentityCryptoError({
              cause,
              operation: "recover-certificate-owner",
            }),
          try: () =>
            recoverTypedDataAddress({
              ...makeDeviceCertificateTypedDataV1(domain, certificate),
              signature: toViemSignature(signature),
            }),
        })
      )
    )
);

export const verifyDeviceCertificateOwnerV1 = Effect.fn(
  "@qop/identity/verifyDeviceCertificateOwnerV1"
)(
  (
    domain: IdentityEip712DomainV1,
    certificate: DeviceCertificate,
    signature: Uint8Array,
    expectedOwner: string
  ) =>
    Schema.decodeUnknownEffect(EthereumAddress)(
      expectedOwner.toLowerCase()
    ).pipe(
      Effect.mapError(
        (cause) =>
          new IdentityCryptoError({
            cause,
            operation: "verify-certificate-owner",
          })
      ),
      Effect.flatMap((owner) =>
        recoverDeviceCertificateOwnerV1(domain, certificate, signature).pipe(
          Effect.map((recovered) => recovered.toLowerCase() === owner)
        )
      )
    )
);
