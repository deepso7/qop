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

export const DeviceKey = Hex32.check(
  Schema.makeFilter((bytes) => bytes.some((byte) => byte !== 0), {
    expected: "a non-zero device key",
  })
);

const OwnerPrivateKey = Schema.Uint8Array.check(
  Schema.makeFilter((bytes) => bytes.length === 32, {
    expected: "a 32-byte owner private key",
  })
);

const RegisterIntentV1Schema = Schema.Struct({
  deadline: UnixSeconds,
  deviceKey: DeviceKey,
  handle: Handle,
  nonce: RegistrationNonce,
  owner: NonZeroEthereumAddress,
}).annotate({
  messageUnexpectedKey: "Unexpected registration intent field",
  parseOptions: strictParseOptions,
});
export { RegisterIntentV1Schema as RegisterIntentV1 };
export type RegisterIntentV1 = typeof RegisterIntentV1Schema.Type;
export type RegisterIntentV1Encoded = typeof RegisterIntentV1Schema.Encoded;

const RotateOwnerIntentV1Schema = Schema.Struct({
  deadline: UnixSeconds,
  newOwner: NonZeroEthereumAddress,
  nonce: Uint256,
  qid: Qid,
}).annotate({
  messageUnexpectedKey: "Unexpected owner rotation intent field",
  parseOptions: strictParseOptions,
});
export { RotateOwnerIntentV1Schema as RotateOwnerIntentV1 };
export type RotateOwnerIntentV1 = typeof RotateOwnerIntentV1Schema.Type;
export type RotateOwnerIntentV1Encoded =
  typeof RotateOwnerIntentV1Schema.Encoded;

const RotateDeviceIntentV1Schema = Schema.Struct({
  deadline: UnixSeconds,
  newDeviceKey: DeviceKey,
  nonce: Uint256,
  qid: Qid,
}).annotate({
  messageUnexpectedKey: "Unexpected device rotation intent field",
  parseOptions: strictParseOptions,
});
export { RotateDeviceIntentV1Schema as RotateDeviceIntentV1 };
export type RotateDeviceIntentV1 = typeof RotateDeviceIntentV1Schema.Type;
export type RotateDeviceIntentV1Encoded =
  typeof RotateDeviceIntentV1Schema.Encoded;

export const registerIntentEip712Types = {
  RegisterV1: [
    { name: "handle", type: "string" },
    { name: "owner", type: "address" },
    { name: "deviceKey", type: "bytes32" },
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

export const rotateDeviceIntentEip712Types = {
  RotateDeviceV1: [
    { name: "qid", type: "uint256" },
    { name: "newDeviceKey", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

const typedDataDomain = (domain: IdentityDomain) => ({
  chainId: domain.chainId,
  name: identityEip712DomainName,
  // SAFETY: The domain schema accepts only canonical 20-byte hex addresses.
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
      deviceKey: toHex(intent.deviceKey),
      handle: intent.handle,
      nonce: toHex(intent.nonce),
      // SAFETY: The intent schema accepts only canonical 20-byte hex addresses.
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
      // SAFETY: The intent schema accepts only canonical 20-byte hex addresses.
      newOwner: intent.newOwner as Address,
      nonce: intent.nonce,
      qid: intent.qid,
    },
    primaryType: "RotateOwnerV1",
    types: rotateOwnerIntentEip712Types,
  }) as const;

export const makeRotateDeviceIntentTypedDataV1 = (
  domain: IdentityDomain,
  intent: RotateDeviceIntentV1
) =>
  ({
    domain: typedDataDomain(domain),
    message: {
      deadline: intent.deadline,
      newDeviceKey: toHex(intent.newDeviceKey),
      nonce: intent.nonce,
      qid: intent.qid,
    },
    primaryType: "RotateDeviceV1",
    types: rotateDeviceIntentEip712Types,
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
    Effect.andThen(Schema.encodeEffect(RegisterIntentV1Schema)(intent)),
    Effect.mapError((cause) => new IdentityCryptoError({ cause, operation }))
  );

const validateRotateOwnerInputs = (
  operation: IdentityCryptoError["operation"],
  domain: IdentityDomain,
  intent: RotateOwnerIntentV1
) =>
  Schema.encodeEffect(IdentityEip712DomainV1)(domain).pipe(
    Effect.andThen(Schema.encodeEffect(RotateOwnerIntentV1Schema)(intent)),
    Effect.mapError((cause) => new IdentityCryptoError({ cause, operation }))
  );

const validateRotateDeviceInputs = (
  operation: IdentityCryptoError["operation"],
  domain: IdentityDomain,
  intent: RotateDeviceIntentV1
) =>
  Schema.encodeEffect(IdentityEip712DomainV1)(domain).pipe(
    Effect.andThen(Schema.encodeEffect(RotateDeviceIntentV1Schema)(intent)),
    Effect.mapError((cause) => new IdentityCryptoError({ cause, operation }))
  );

export const decodeRegisterIntentV1 = Effect.fn(
  "@qop/identity/decodeRegisterIntentV1"
)((input: RegisterIntentV1Encoded) =>
  Schema.decodeEffect(RegisterIntentV1Schema)(input)
);

export const decodeRotateOwnerIntentV1 = Effect.fn(
  "@qop/identity/decodeRotateOwnerIntentV1"
)((input: RotateOwnerIntentV1Encoded) =>
  Schema.decodeEffect(RotateOwnerIntentV1Schema)(input)
);

export const decodeRotateDeviceIntentV1 = Effect.fn(
  "@qop/identity/decodeRotateDeviceIntentV1"
)((input: RotateDeviceIntentV1Encoded) =>
  Schema.decodeEffect(RotateDeviceIntentV1Schema)(input)
);

export const encodeRegisterIntentV1 = Effect.fn(
  "@qop/identity/encodeRegisterIntentV1"
)((intent: RegisterIntentV1) =>
  Schema.encodeEffect(RegisterIntentV1Schema)(intent)
);

export const encodeRotateOwnerIntentV1 = Effect.fn(
  "@qop/identity/encodeRotateOwnerIntentV1"
)((intent: RotateOwnerIntentV1) =>
  Schema.encodeEffect(RotateOwnerIntentV1Schema)(intent)
);

export const encodeRotateDeviceIntentV1 = Effect.fn(
  "@qop/identity/encodeRotateDeviceIntentV1"
)((intent: RotateDeviceIntentV1) =>
  Schema.encodeEffect(RotateDeviceIntentV1Schema)(intent)
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

export const hashRotateDeviceIntentV1 = Effect.fn(
  "@qop/identity/hashRotateDeviceIntentV1"
)((domain: IdentityDomain, intent: RotateDeviceIntentV1) =>
  validateRotateDeviceInputs("hash-rotate-device-intent", domain, intent).pipe(
    Effect.flatMap(() =>
      Effect.try({
        catch: (cause) =>
          new IdentityCryptoError({
            cause,
            operation: "hash-rotate-device-intent",
          }),
        try: () =>
          hashTypedData(makeRotateDeviceIntentTypedDataV1(domain, intent)),
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

export const recoverRotateDeviceIntentSignerV1 = Effect.fn(
  "@qop/identity/recoverRotateDeviceIntentSignerV1"
)(
  (
    domain: IdentityDomain,
    intent: RotateDeviceIntentV1,
    signature: Uint8Array
  ) =>
    validateRotateDeviceInputs(
      "recover-rotate-device-intent-signer",
      domain,
      intent
    ).pipe(
      Effect.andThen(
        validateSignature("recover-rotate-device-intent-signer", signature)
      ),
      Effect.flatMap(() =>
        Effect.tryPromise({
          catch: (cause) =>
            new IdentityCryptoError({
              cause,
              operation: "recover-rotate-device-intent-signer",
            }),
          try: () =>
            recoverTypedDataAddress({
              ...makeRotateDeviceIntentTypedDataV1(domain, intent),
              signature: toViemSignature(signature),
            }),
        })
      ),
      Effect.map((address) => address.toLowerCase())
    )
);
