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

const RecoverOwnerIntentV1Schema = Schema.Struct({
  deadline: UnixSeconds,
  newOwner: NonZeroEthereumAddress,
  nonce: Uint256,
  qid: Qid,
}).annotate({
  messageUnexpectedKey: "Unexpected owner recovery intent field",
  parseOptions: strictParseOptions,
});
export { RecoverOwnerIntentV1Schema as RecoverOwnerIntentV1 };
export type RecoverOwnerIntentV1 = typeof RecoverOwnerIntentV1Schema.Type;
export type RecoverOwnerIntentV1Encoded =
  typeof RecoverOwnerIntentV1Schema.Encoded;

const AddDeviceIntentV1Schema = Schema.Struct({
  deadline: UnixSeconds,
  deviceKey: DeviceKey,
  nonce: Uint256,
  qid: Qid,
}).annotate({
  messageUnexpectedKey: "Unexpected add-device intent field",
  parseOptions: strictParseOptions,
});
export { AddDeviceIntentV1Schema as AddDeviceIntentV1 };
export type AddDeviceIntentV1 = typeof AddDeviceIntentV1Schema.Type;
export type AddDeviceIntentV1Encoded = typeof AddDeviceIntentV1Schema.Encoded;

const RemoveDeviceIntentV1Schema = Schema.Struct({
  deadline: UnixSeconds,
  deviceKey: DeviceKey,
  nonce: Uint256,
  qid: Qid,
}).annotate({
  messageUnexpectedKey: "Unexpected remove-device intent field",
  parseOptions: strictParseOptions,
});
export { RemoveDeviceIntentV1Schema as RemoveDeviceIntentV1 };
export type RemoveDeviceIntentV1 = typeof RemoveDeviceIntentV1Schema.Type;
export type RemoveDeviceIntentV1Encoded =
  typeof RemoveDeviceIntentV1Schema.Encoded;

const WipeDevicesIntentV1Schema = Schema.Struct({
  deadline: UnixSeconds,
  nonce: Uint256,
  qid: Qid,
}).annotate({
  messageUnexpectedKey: "Unexpected wipe-devices intent field",
  parseOptions: strictParseOptions,
});
export { WipeDevicesIntentV1Schema as WipeDevicesIntentV1 };
export type WipeDevicesIntentV1 = typeof WipeDevicesIntentV1Schema.Type;
export type WipeDevicesIntentV1Encoded =
  typeof WipeDevicesIntentV1Schema.Encoded;

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

export const recoverOwnerIntentEip712Types = {
  RecoverOwnerV1: [
    { name: "qid", type: "uint256" },
    { name: "newOwner", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export const addDeviceIntentEip712Types = {
  AddDeviceV1: [
    { name: "qid", type: "uint256" },
    { name: "deviceKey", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export const removeDeviceIntentEip712Types = {
  RemoveDeviceV1: [
    { name: "qid", type: "uint256" },
    { name: "deviceKey", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export const wipeDevicesIntentEip712Types = {
  WipeDevicesV1: [
    { name: "qid", type: "uint256" },
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

export const makeRecoverOwnerIntentTypedDataV1 = (
  domain: IdentityDomain,
  intent: RecoverOwnerIntentV1
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
    primaryType: "RecoverOwnerV1",
    types: recoverOwnerIntentEip712Types,
  }) as const;

export const makeAddDeviceIntentTypedDataV1 = (
  domain: IdentityDomain,
  intent: AddDeviceIntentV1
) =>
  ({
    domain: typedDataDomain(domain),
    message: {
      deadline: intent.deadline,
      deviceKey: toHex(intent.deviceKey),
      nonce: intent.nonce,
      qid: intent.qid,
    },
    primaryType: "AddDeviceV1",
    types: addDeviceIntentEip712Types,
  }) as const;

export const makeRemoveDeviceIntentTypedDataV1 = (
  domain: IdentityDomain,
  intent: RemoveDeviceIntentV1
) =>
  ({
    domain: typedDataDomain(domain),
    message: {
      deadline: intent.deadline,
      deviceKey: toHex(intent.deviceKey),
      nonce: intent.nonce,
      qid: intent.qid,
    },
    primaryType: "RemoveDeviceV1",
    types: removeDeviceIntentEip712Types,
  }) as const;

export const makeWipeDevicesIntentTypedDataV1 = (
  domain: IdentityDomain,
  intent: WipeDevicesIntentV1
) =>
  ({
    domain: typedDataDomain(domain),
    message: {
      deadline: intent.deadline,
      nonce: intent.nonce,
      qid: intent.qid,
    },
    primaryType: "WipeDevicesV1",
    types: wipeDevicesIntentEip712Types,
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

const validateRecoverOwnerInputs = (
  operation: IdentityCryptoError["operation"],
  domain: IdentityDomain,
  intent: RecoverOwnerIntentV1
) =>
  Schema.encodeEffect(IdentityEip712DomainV1)(domain).pipe(
    Effect.andThen(Schema.encodeEffect(RecoverOwnerIntentV1Schema)(intent)),
    Effect.mapError((cause) => new IdentityCryptoError({ cause, operation }))
  );

const validateAddDeviceInputs = (
  operation: IdentityCryptoError["operation"],
  domain: IdentityDomain,
  intent: AddDeviceIntentV1
) =>
  Schema.encodeEffect(IdentityEip712DomainV1)(domain).pipe(
    Effect.andThen(Schema.encodeEffect(AddDeviceIntentV1Schema)(intent)),
    Effect.mapError((cause) => new IdentityCryptoError({ cause, operation }))
  );

const validateRemoveDeviceInputs = (
  operation: IdentityCryptoError["operation"],
  domain: IdentityDomain,
  intent: RemoveDeviceIntentV1
) =>
  Schema.encodeEffect(IdentityEip712DomainV1)(domain).pipe(
    Effect.andThen(Schema.encodeEffect(RemoveDeviceIntentV1Schema)(intent)),
    Effect.mapError((cause) => new IdentityCryptoError({ cause, operation }))
  );

const validateWipeDevicesInputs = (
  operation: IdentityCryptoError["operation"],
  domain: IdentityDomain,
  intent: WipeDevicesIntentV1
) =>
  Schema.encodeEffect(IdentityEip712DomainV1)(domain).pipe(
    Effect.andThen(Schema.encodeEffect(WipeDevicesIntentV1Schema)(intent)),
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

export const decodeRecoverOwnerIntentV1 = Effect.fn(
  "@qop/identity/decodeRecoverOwnerIntentV1"
)((input: RecoverOwnerIntentV1Encoded) =>
  Schema.decodeEffect(RecoverOwnerIntentV1Schema)(input)
);

export const decodeAddDeviceIntentV1 = Effect.fn(
  "@qop/identity/decodeAddDeviceIntentV1"
)((input: AddDeviceIntentV1Encoded) =>
  Schema.decodeEffect(AddDeviceIntentV1Schema)(input)
);

export const decodeRemoveDeviceIntentV1 = Effect.fn(
  "@qop/identity/decodeRemoveDeviceIntentV1"
)((input: RemoveDeviceIntentV1Encoded) =>
  Schema.decodeEffect(RemoveDeviceIntentV1Schema)(input)
);

export const decodeWipeDevicesIntentV1 = Effect.fn(
  "@qop/identity/decodeWipeDevicesIntentV1"
)((input: WipeDevicesIntentV1Encoded) =>
  Schema.decodeEffect(WipeDevicesIntentV1Schema)(input)
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

export const encodeRecoverOwnerIntentV1 = Effect.fn(
  "@qop/identity/encodeRecoverOwnerIntentV1"
)((intent: RecoverOwnerIntentV1) =>
  Schema.encodeEffect(RecoverOwnerIntentV1Schema)(intent)
);

export const encodeAddDeviceIntentV1 = Effect.fn(
  "@qop/identity/encodeAddDeviceIntentV1"
)((intent: AddDeviceIntentV1) =>
  Schema.encodeEffect(AddDeviceIntentV1Schema)(intent)
);

export const encodeRemoveDeviceIntentV1 = Effect.fn(
  "@qop/identity/encodeRemoveDeviceIntentV1"
)((intent: RemoveDeviceIntentV1) =>
  Schema.encodeEffect(RemoveDeviceIntentV1Schema)(intent)
);

export const encodeWipeDevicesIntentV1 = Effect.fn(
  "@qop/identity/encodeWipeDevicesIntentV1"
)((intent: WipeDevicesIntentV1) =>
  Schema.encodeEffect(WipeDevicesIntentV1Schema)(intent)
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

export const signWipeDevicesIntentV1 = Effect.fn(
  "@qop/identity/signWipeDevicesIntentV1"
)(function* (
  domain: IdentityDomain,
  intent: WipeDevicesIntentV1,
  input: Uint8Array
) {
  yield* validateWipeDevicesInputs("sign-wipe-devices-intent", domain, intent);
  const privateKey = yield* Schema.decodeUnknownEffect(OwnerPrivateKey)(
    input
  ).pipe(
    Effect.mapError(
      (cause) =>
        new IdentityCryptoError({
          cause,
          operation: "sign-wipe-devices-intent",
        })
    )
  );
  const account = yield* Effect.try({
    catch: (cause) =>
      new IdentityCryptoError({ cause, operation: "sign-wipe-devices-intent" }),
    try: () => privateKeyToAccount(toHex(privateKey)),
  });
  const signature = yield* Effect.tryPromise({
    catch: (cause) =>
      new IdentityCryptoError({ cause, operation: "sign-wipe-devices-intent" }),
    try: () =>
      account.signTypedData(makeWipeDevicesIntentTypedDataV1(domain, intent)),
  });
  return yield* normalizeEcdsaSignature(signature).pipe(
    Effect.mapError(
      (cause) =>
        new IdentityCryptoError({
          cause,
          operation: "sign-wipe-devices-intent",
        })
    )
  );
});

export const signAddDeviceIntentV1 = Effect.fn(
  "@qop/identity/signAddDeviceIntentV1"
)(function* (
  domain: IdentityDomain,
  intent: AddDeviceIntentV1,
  input: Uint8Array
) {
  yield* validateAddDeviceInputs("sign-add-device-intent", domain, intent);
  const privateKey = yield* Schema.decodeUnknownEffect(OwnerPrivateKey)(
    input
  ).pipe(
    Effect.mapError(
      (cause) =>
        new IdentityCryptoError({ cause, operation: "sign-add-device-intent" })
    )
  );
  const account = yield* Effect.try({
    catch: (cause) =>
      new IdentityCryptoError({ cause, operation: "sign-add-device-intent" }),
    try: () => privateKeyToAccount(toHex(privateKey)),
  });
  const signature = yield* Effect.tryPromise({
    catch: (cause) =>
      new IdentityCryptoError({ cause, operation: "sign-add-device-intent" }),
    try: () =>
      account.signTypedData(makeAddDeviceIntentTypedDataV1(domain, intent)),
  });
  return yield* normalizeEcdsaSignature(signature).pipe(
    Effect.mapError(
      (cause) =>
        new IdentityCryptoError({ cause, operation: "sign-add-device-intent" })
    )
  );
});

export const signRemoveDeviceIntentV1 = Effect.fn(
  "@qop/identity/signRemoveDeviceIntentV1"
)(function* (
  domain: IdentityDomain,
  intent: RemoveDeviceIntentV1,
  input: Uint8Array
) {
  yield* validateRemoveDeviceInputs(
    "sign-remove-device-intent",
    domain,
    intent
  );
  const privateKey = yield* Schema.decodeUnknownEffect(OwnerPrivateKey)(
    input
  ).pipe(
    Effect.mapError(
      (cause) =>
        new IdentityCryptoError({
          cause,
          operation: "sign-remove-device-intent",
        })
    )
  );
  const account = yield* Effect.try({
    catch: (cause) =>
      new IdentityCryptoError({
        cause,
        operation: "sign-remove-device-intent",
      }),
    try: () => privateKeyToAccount(toHex(privateKey)),
  });
  const signature = yield* Effect.tryPromise({
    catch: (cause) =>
      new IdentityCryptoError({
        cause,
        operation: "sign-remove-device-intent",
      }),
    try: () =>
      account.signTypedData(makeRemoveDeviceIntentTypedDataV1(domain, intent)),
  });
  return yield* normalizeEcdsaSignature(signature).pipe(
    Effect.mapError(
      (cause) =>
        new IdentityCryptoError({
          cause,
          operation: "sign-remove-device-intent",
        })
    )
  );
});

export const signRecoverOwnerIntentV1 = Effect.fn(
  "@qop/identity/signRecoverOwnerIntentV1"
)(function* (
  domain: IdentityDomain,
  intent: RecoverOwnerIntentV1,
  input: Uint8Array
) {
  yield* validateRecoverOwnerInputs(
    "sign-recover-owner-intent",
    domain,
    intent
  );
  const privateKey = yield* Schema.decodeUnknownEffect(OwnerPrivateKey)(
    input
  ).pipe(
    Effect.mapError(
      (cause) =>
        new IdentityCryptoError({
          cause,
          operation: "sign-recover-owner-intent",
        })
    )
  );
  const account = yield* Effect.try({
    catch: (cause) =>
      new IdentityCryptoError({
        cause,
        operation: "sign-recover-owner-intent",
      }),
    try: () => privateKeyToAccount(toHex(privateKey)),
  });
  const signature = yield* Effect.tryPromise({
    catch: (cause) =>
      new IdentityCryptoError({
        cause,
        operation: "sign-recover-owner-intent",
      }),
    try: () =>
      account.signTypedData(makeRecoverOwnerIntentTypedDataV1(domain, intent)),
  });
  return yield* normalizeEcdsaSignature(signature).pipe(
    Effect.mapError(
      (cause) =>
        new IdentityCryptoError({
          cause,
          operation: "sign-recover-owner-intent",
        })
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

export const hashRecoverOwnerIntentV1 = Effect.fn(
  "@qop/identity/hashRecoverOwnerIntentV1"
)((domain: IdentityDomain, intent: RecoverOwnerIntentV1) =>
  validateRecoverOwnerInputs("hash-recover-owner-intent", domain, intent).pipe(
    Effect.flatMap(() =>
      Effect.try({
        catch: (cause) =>
          new IdentityCryptoError({
            cause,
            operation: "hash-recover-owner-intent",
          }),
        try: () =>
          hashTypedData(makeRecoverOwnerIntentTypedDataV1(domain, intent)),
      })
    )
  )
);

export const hashAddDeviceIntentV1 = Effect.fn(
  "@qop/identity/hashAddDeviceIntentV1"
)((domain: IdentityDomain, intent: AddDeviceIntentV1) =>
  validateAddDeviceInputs("hash-add-device-intent", domain, intent).pipe(
    Effect.flatMap(() =>
      Effect.try({
        catch: (cause) =>
          new IdentityCryptoError({
            cause,
            operation: "hash-add-device-intent",
          }),
        try: () =>
          hashTypedData(makeAddDeviceIntentTypedDataV1(domain, intent)),
      })
    )
  )
);

export const hashRemoveDeviceIntentV1 = Effect.fn(
  "@qop/identity/hashRemoveDeviceIntentV1"
)((domain: IdentityDomain, intent: RemoveDeviceIntentV1) =>
  validateRemoveDeviceInputs("hash-remove-device-intent", domain, intent).pipe(
    Effect.flatMap(() =>
      Effect.try({
        catch: (cause) =>
          new IdentityCryptoError({
            cause,
            operation: "hash-remove-device-intent",
          }),
        try: () =>
          hashTypedData(makeRemoveDeviceIntentTypedDataV1(domain, intent)),
      })
    )
  )
);

export const hashWipeDevicesIntentV1 = Effect.fn(
  "@qop/identity/hashWipeDevicesIntentV1"
)((domain: IdentityDomain, intent: WipeDevicesIntentV1) =>
  validateWipeDevicesInputs("hash-wipe-devices-intent", domain, intent).pipe(
    Effect.flatMap(() =>
      Effect.try({
        catch: (cause) =>
          new IdentityCryptoError({
            cause,
            operation: "hash-wipe-devices-intent",
          }),
        try: () =>
          hashTypedData(makeWipeDevicesIntentTypedDataV1(domain, intent)),
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

export const recoverRecoverOwnerIntentSignerV1 = Effect.fn(
  "@qop/identity/recoverRecoverOwnerIntentSignerV1"
)(
  (
    domain: IdentityDomain,
    intent: RecoverOwnerIntentV1,
    signature: Uint8Array
  ) =>
    validateRecoverOwnerInputs(
      "recover-recover-owner-intent-signer",
      domain,
      intent
    ).pipe(
      Effect.andThen(
        validateSignature("recover-recover-owner-intent-signer", signature)
      ),
      Effect.flatMap(() =>
        Effect.tryPromise({
          catch: (cause) =>
            new IdentityCryptoError({
              cause,
              operation: "recover-recover-owner-intent-signer",
            }),
          try: () =>
            recoverTypedDataAddress({
              ...makeRecoverOwnerIntentTypedDataV1(domain, intent),
              signature: toViemSignature(signature),
            }),
        })
      ),
      Effect.map((address) => address.toLowerCase())
    )
);

export const recoverAddDeviceIntentSignerV1 = Effect.fn(
  "@qop/identity/recoverAddDeviceIntentSignerV1"
)((domain: IdentityDomain, intent: AddDeviceIntentV1, signature: Uint8Array) =>
  validateAddDeviceInputs(
    "recover-add-device-intent-signer",
    domain,
    intent
  ).pipe(
    Effect.andThen(
      validateSignature("recover-add-device-intent-signer", signature)
    ),
    Effect.flatMap(() =>
      Effect.tryPromise({
        catch: (cause) =>
          new IdentityCryptoError({
            cause,
            operation: "recover-add-device-intent-signer",
          }),
        try: () =>
          recoverTypedDataAddress({
            ...makeAddDeviceIntentTypedDataV1(domain, intent),
            signature: toViemSignature(signature),
          }),
      })
    ),
    Effect.map((address) => address.toLowerCase())
  )
);

export const recoverRemoveDeviceIntentSignerV1 = Effect.fn(
  "@qop/identity/recoverRemoveDeviceIntentSignerV1"
)(
  (
    domain: IdentityDomain,
    intent: RemoveDeviceIntentV1,
    signature: Uint8Array
  ) =>
    validateRemoveDeviceInputs(
      "recover-remove-device-intent-signer",
      domain,
      intent
    ).pipe(
      Effect.andThen(
        validateSignature("recover-remove-device-intent-signer", signature)
      ),
      Effect.flatMap(() =>
        Effect.tryPromise({
          catch: (cause) =>
            new IdentityCryptoError({
              cause,
              operation: "recover-remove-device-intent-signer",
            }),
          try: () =>
            recoverTypedDataAddress({
              ...makeRemoveDeviceIntentTypedDataV1(domain, intent),
              signature: toViemSignature(signature),
            }),
        })
      ),
      Effect.map((address) => address.toLowerCase())
    )
);

export const recoverWipeDevicesIntentSignerV1 = Effect.fn(
  "@qop/identity/recoverWipeDevicesIntentSignerV1"
)(
  (
    domain: IdentityDomain,
    intent: WipeDevicesIntentV1,
    signature: Uint8Array
  ) =>
    validateWipeDevicesInputs(
      "recover-wipe-devices-intent-signer",
      domain,
      intent
    ).pipe(
      Effect.andThen(
        validateSignature("recover-wipe-devices-intent-signer", signature)
      ),
      Effect.flatMap(() =>
        Effect.tryPromise({
          catch: (cause) =>
            new IdentityCryptoError({
              cause,
              operation: "recover-wipe-devices-intent-signer",
            }),
          try: () =>
            recoverTypedDataAddress({
              ...makeWipeDevicesIntentTypedDataV1(domain, intent),
              signature: toViemSignature(signature),
            }),
        })
      ),
      Effect.map((address) => address.toLowerCase())
    )
);
