import { Effect, Schema } from "effect";
import { hashTypedData, recoverTypedDataAddress, toHex } from "viem";
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  IdentityCryptoError,
  IdentityEip712DomainV1,
  identityEip712DomainName,
  identityEip712DomainVersion,
} from "./eip712.ts";
import type { IdentityEip712DomainV1 as IdentityDomain } from "./eip712.ts";
import { strictParseOptions, toViemSignature } from "./internal.ts";
import {
  EcdsaSignature,
  EthereumAddress,
  Handle,
  Hex32,
  normalizeEcdsaSignature,
  Qid,
  Uint256,
  UnixSeconds,
} from "./wire-codecs.ts";

const ZERO_ADDRESS = `0x${"00".repeat(20)}`;

const NonZeroEthereumAddress = EthereumAddress.check(
  Schema.makeFilter((address) => address !== ZERO_ADDRESS, {
    expected: "a non-zero Ethereum address",
  })
);

export const RegistrationNonce = Hex32.check(
  Schema.makeFilter((bytes) => bytes.some((byte) => byte !== 0), {
    expected: "a non-zero registration nonce",
  })
);

export const CertificateDigest = Hex32.check(
  Schema.makeFilter((bytes) => bytes.some((byte) => byte !== 0), {
    expected: "a non-zero certificate digest",
  })
);

export const DeviceCommitment = Hex32.check(
  Schema.makeFilter((bytes) => bytes.some((byte) => byte !== 0), {
    expected: "a non-zero device commitment",
  })
);

const OwnerPrivateKey = Schema.Uint8Array.check(
  Schema.makeFilter((bytes) => bytes.length === 32, {
    expected: "a 32-byte owner private key",
  })
);

export const RegisterIntentV1 = Schema.Struct({
  deadline: UnixSeconds,
  deviceCommitment: DeviceCommitment,
  handle: Handle,
  nonce: RegistrationNonce,
  owner: NonZeroEthereumAddress,
}).annotate({
  messageUnexpectedKey: "Unexpected registration intent field",
  parseOptions: strictParseOptions,
});

export type RegisterIntentV1 = typeof RegisterIntentV1.Type;
export type RegisterIntentV1Encoded = typeof RegisterIntentV1.Encoded;

export const RotateOwnerIntentV1 = Schema.Struct({
  deadline: UnixSeconds,
  newOwner: NonZeroEthereumAddress,
  nonce: Uint256,
  qid: Qid,
}).annotate({
  messageUnexpectedKey: "Unexpected owner rotation intent field",
  parseOptions: strictParseOptions,
});

export type RotateOwnerIntentV1 = typeof RotateOwnerIntentV1.Type;
export type RotateOwnerIntentV1Encoded = typeof RotateOwnerIntentV1.Encoded;

export const RevokeDeviceIntentV1 = Schema.Struct({
  certificateDigest: CertificateDigest,
  deadline: UnixSeconds,
  nonce: Uint256,
  qid: Qid,
}).annotate({
  messageUnexpectedKey: "Unexpected device revocation intent field",
  parseOptions: strictParseOptions,
});

export type RevokeDeviceIntentV1 = typeof RevokeDeviceIntentV1.Type;
export type RevokeDeviceIntentV1Encoded = typeof RevokeDeviceIntentV1.Encoded;

export const registerIntentEip712Types = {
  RegisterV1: [
    { name: "handle", type: "string" },
    { name: "owner", type: "address" },
    { name: "deviceCommitment", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export const rotateOwnerIntentEip712Types = {
  RotateOwnerV1: [
    { name: "qid", type: "uint256" },
    { name: "newOwner", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export const revokeDeviceIntentEip712Types = {
  RevokeDeviceV1: [
    { name: "qid", type: "uint256" },
    { name: "certificateDigest", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

const typedDataDomain = (domain: IdentityDomain) => ({
  chainId: domain.chainId,
  name: identityEip712DomainName,
  verifyingContract: domain.verifyingContract as Address,
  version: identityEip712DomainVersion,
});

export const makeRegisterIntentTypedDataV1 = (
  domain: IdentityDomain,
  intent: RegisterIntentV1
) =>
  ({
    domain: typedDataDomain(domain),
    message: {
      deadline: intent.deadline,
      deviceCommitment: toHex(intent.deviceCommitment),
      handle: intent.handle,
      nonce: toHex(intent.nonce),
      owner: intent.owner as Address,
    },
    primaryType: "RegisterV1",
    types: registerIntentEip712Types,
  }) as const;

export const makeRotateOwnerIntentTypedDataV1 = (
  domain: IdentityDomain,
  intent: RotateOwnerIntentV1
) =>
  ({
    domain: typedDataDomain(domain),
    message: {
      deadline: intent.deadline,
      newOwner: intent.newOwner as Address,
      nonce: intent.nonce,
      qid: intent.qid,
    },
    primaryType: "RotateOwnerV1",
    types: rotateOwnerIntentEip712Types,
  }) as const;

export const makeRevokeDeviceIntentTypedDataV1 = (
  domain: IdentityDomain,
  intent: RevokeDeviceIntentV1
) =>
  ({
    domain: typedDataDomain(domain),
    message: {
      certificateDigest: toHex(intent.certificateDigest),
      deadline: intent.deadline,
      nonce: intent.nonce,
      qid: intent.qid,
    },
    primaryType: "RevokeDeviceV1",
    types: revokeDeviceIntentEip712Types,
  }) as const;

const validateSignature = (
  operation: IdentityCryptoError["operation"],
  signature: Uint8Array
) =>
  Schema.encodeEffect(EcdsaSignature)(signature).pipe(
    Effect.mapError((cause) => new IdentityCryptoError({ cause, operation }))
  );

const validateRegisterInputs = (
  operation: IdentityCryptoError["operation"],
  domain: IdentityDomain,
  intent: RegisterIntentV1
) =>
  Schema.encodeEffect(IdentityEip712DomainV1)(domain).pipe(
    Effect.andThen(Schema.encodeEffect(RegisterIntentV1)(intent)),
    Effect.mapError((cause) => new IdentityCryptoError({ cause, operation }))
  );

const validateRotateOwnerInputs = (
  operation: IdentityCryptoError["operation"],
  domain: IdentityDomain,
  intent: RotateOwnerIntentV1
) =>
  Schema.encodeEffect(IdentityEip712DomainV1)(domain).pipe(
    Effect.andThen(Schema.encodeEffect(RotateOwnerIntentV1)(intent)),
    Effect.mapError((cause) => new IdentityCryptoError({ cause, operation }))
  );

const validateRevokeDeviceInputs = (
  operation: IdentityCryptoError["operation"],
  domain: IdentityDomain,
  intent: RevokeDeviceIntentV1
) =>
  Schema.encodeEffect(IdentityEip712DomainV1)(domain).pipe(
    Effect.andThen(Schema.encodeEffect(RevokeDeviceIntentV1)(intent)),
    Effect.mapError((cause) => new IdentityCryptoError({ cause, operation }))
  );

export const decodeRegisterIntentV1 = Effect.fn(
  "@qop/identity/decodeRegisterIntentV1"
)((input: unknown) => Schema.decodeUnknownEffect(RegisterIntentV1)(input));

export const decodeRotateOwnerIntentV1 = Effect.fn(
  "@qop/identity/decodeRotateOwnerIntentV1"
)((input: unknown) => Schema.decodeUnknownEffect(RotateOwnerIntentV1)(input));

export const decodeRevokeDeviceIntentV1 = Effect.fn(
  "@qop/identity/decodeRevokeDeviceIntentV1"
)((input: unknown) => Schema.decodeUnknownEffect(RevokeDeviceIntentV1)(input));

export const encodeRegisterIntentV1 = Effect.fn(
  "@qop/identity/encodeRegisterIntentV1"
)((intent: RegisterIntentV1) => Schema.encodeEffect(RegisterIntentV1)(intent));

export const encodeRotateOwnerIntentV1 = Effect.fn(
  "@qop/identity/encodeRotateOwnerIntentV1"
)((intent: RotateOwnerIntentV1) =>
  Schema.encodeEffect(RotateOwnerIntentV1)(intent)
);

export const encodeRevokeDeviceIntentV1 = Effect.fn(
  "@qop/identity/encodeRevokeDeviceIntentV1"
)((intent: RevokeDeviceIntentV1) =>
  Schema.encodeEffect(RevokeDeviceIntentV1)(intent)
);

export const hashRegisterIntentV1 = Effect.fn(
  "@qop/identity/hashRegisterIntentV1"
)((domain: IdentityDomain, intent: RegisterIntentV1) =>
  validateRegisterInputs("hash-register-intent", domain, intent).pipe(
    Effect.flatMap(() =>
      Effect.try({
        catch: (cause) =>
          new IdentityCryptoError({
            cause,
            operation: "hash-register-intent",
          }),
        try: () => hashTypedData(makeRegisterIntentTypedDataV1(domain, intent)),
      })
    )
  )
);

export const signRegisterIntentV1 = Effect.fn(
  "@qop/identity/signRegisterIntentV1"
)(function* (
  domain: IdentityDomain,
  intent: RegisterIntentV1,
  input: Uint8Array
) {
  yield* validateRegisterInputs("sign-register-intent", domain, intent);
  const privateKey = yield* Schema.decodeUnknownEffect(OwnerPrivateKey)(
    input
  ).pipe(
    Effect.mapError(
      (cause) =>
        new IdentityCryptoError({ cause, operation: "sign-register-intent" })
    )
  );
  const account = yield* Effect.try({
    catch: (cause) =>
      new IdentityCryptoError({ cause, operation: "sign-register-intent" }),
    try: () => privateKeyToAccount(toHex(privateKey)),
  });
  const signature = yield* Effect.tryPromise({
    catch: (cause) =>
      new IdentityCryptoError({ cause, operation: "sign-register-intent" }),
    try: () =>
      account.signTypedData(makeRegisterIntentTypedDataV1(domain, intent)),
  });
  return yield* normalizeEcdsaSignature(signature).pipe(
    Effect.mapError(
      (cause) =>
        new IdentityCryptoError({ cause, operation: "sign-register-intent" })
    )
  );
});

export const hashRotateOwnerIntentV1 = Effect.fn(
  "@qop/identity/hashRotateOwnerIntentV1"
)((domain: IdentityDomain, intent: RotateOwnerIntentV1) =>
  validateRotateOwnerInputs("hash-rotate-owner-intent", domain, intent).pipe(
    Effect.flatMap(() =>
      Effect.try({
        catch: (cause) =>
          new IdentityCryptoError({
            cause,
            operation: "hash-rotate-owner-intent",
          }),
        try: () =>
          hashTypedData(makeRotateOwnerIntentTypedDataV1(domain, intent)),
      })
    )
  )
);

export const hashRevokeDeviceIntentV1 = Effect.fn(
  "@qop/identity/hashRevokeDeviceIntentV1"
)((domain: IdentityDomain, intent: RevokeDeviceIntentV1) =>
  validateRevokeDeviceInputs("hash-revoke-device-intent", domain, intent).pipe(
    Effect.flatMap(() =>
      Effect.try({
        catch: (cause) =>
          new IdentityCryptoError({
            cause,
            operation: "hash-revoke-device-intent",
          }),
        try: () =>
          hashTypedData(makeRevokeDeviceIntentTypedDataV1(domain, intent)),
      })
    )
  )
);

export const recoverRegisterIntentSignerV1 = Effect.fn(
  "@qop/identity/recoverRegisterIntentSignerV1"
)((domain: IdentityDomain, intent: RegisterIntentV1, signature: Uint8Array) =>
  validateRegisterInputs("recover-register-intent-signer", domain, intent).pipe(
    Effect.andThen(
      validateSignature("recover-register-intent-signer", signature)
    ),
    Effect.flatMap(() =>
      Effect.tryPromise({
        catch: (cause) =>
          new IdentityCryptoError({
            cause,
            operation: "recover-register-intent-signer",
          }),
        try: () =>
          recoverTypedDataAddress({
            ...makeRegisterIntentTypedDataV1(domain, intent),
            signature: toViemSignature(signature),
          }),
      })
    ),
    Effect.map((address) => address.toLowerCase())
  )
);

export const recoverRotateOwnerIntentSignerV1 = Effect.fn(
  "@qop/identity/recoverRotateOwnerIntentSignerV1"
)(
  (
    domain: IdentityDomain,
    intent: RotateOwnerIntentV1,
    signature: Uint8Array
  ) =>
    validateRotateOwnerInputs(
      "recover-rotate-owner-intent-signer",
      domain,
      intent
    ).pipe(
      Effect.andThen(
        validateSignature("recover-rotate-owner-intent-signer", signature)
      ),
      Effect.flatMap(() =>
        Effect.tryPromise({
          catch: (cause) =>
            new IdentityCryptoError({
              cause,
              operation: "recover-rotate-owner-intent-signer",
            }),
          try: () =>
            recoverTypedDataAddress({
              ...makeRotateOwnerIntentTypedDataV1(domain, intent),
              signature: toViemSignature(signature),
            }),
        })
      ),
      Effect.map((address) => address.toLowerCase())
    )
);

export const recoverRevokeDeviceIntentSignerV1 = Effect.fn(
  "@qop/identity/recoverRevokeDeviceIntentSignerV1"
)(
  (
    domain: IdentityDomain,
    intent: RevokeDeviceIntentV1,
    signature: Uint8Array
  ) =>
    validateRevokeDeviceInputs(
      "recover-revoke-device-intent-signer",
      domain,
      intent
    ).pipe(
      Effect.andThen(
        validateSignature("recover-revoke-device-intent-signer", signature)
      ),
      Effect.flatMap(() =>
        Effect.tryPromise({
          catch: (cause) =>
            new IdentityCryptoError({
              cause,
              operation: "recover-revoke-device-intent-signer",
            }),
          try: () =>
            recoverTypedDataAddress({
              ...makeRevokeDeviceIntentTypedDataV1(domain, intent),
              signature: toViemSignature(signature),
            }),
        })
      ),
      Effect.map((address) => address.toLowerCase())
    )
);
