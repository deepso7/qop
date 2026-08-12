import { Data, Effect, Schema } from "effect";
import { concatBytes, keccak256, stringToBytes, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { Base64Url32 } from "./wire-codecs.ts";

const RECOVERY_KEY_DOMAIN = stringToBytes("qop/recovery-key/v1");
const RECOVERY_KEY_PREFIX = "qop1_";
const RECOVERY_KEY_PAYLOAD_LENGTH = 43;
const RECOVERY_KEY_CHECKSUM_LENGTH = 8;
// oxlint-disable unicorn/numeric-separators-style -- Keep the standard secp256k1 constant recognizable.
const SECP256K1_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
// oxlint-enable unicorn/numeric-separators-style

const bytesToBigInt = (bytes: Uint8Array): bigint => {
  let value = 0n;
  for (const byte of bytes) {
    value = value * 256n + BigInt(byte);
  }
  return value;
};

const OwnerPrivateKey = Schema.Uint8Array.check(
  Schema.makeFilter((bytes) => bytes.length === 32, {
    expected: "exactly 32 bytes",
  }),
  Schema.makeFilter(
    (bytes) => {
      const value = bytesToBigInt(bytes);
      return value > 0n && value < SECP256K1_ORDER;
    },
    { expected: "a valid secp256k1 private key" }
  )
);

const RecoveryKeyV1String = Schema.String.check(
  Schema.isPattern(/^qop1_[A-Za-z0-9_-]{43}_[0-9a-f]{8}$/u, {
    expected: "a canonical qop v1 recovery key",
  })
);

export class RecoveryKeyError extends Data.TaggedError("RecoveryKeyError")<{
  readonly operation: "decode" | "derive-owner" | "encode";
}> {}

const checksum = (privateKey: Uint8Array) =>
  keccak256(concatBytes([RECOVERY_KEY_DOMAIN, privateKey])).slice(
    2,
    2 + RECOVERY_KEY_CHECKSUM_LENGTH
  );

export const encodeRecoveryKeyV1 = Effect.fn(
  "@qop/identity/encodeRecoveryKeyV1"
)(function* (input: Uint8Array) {
  const privateKey = yield* Schema.decodeUnknownEffect(OwnerPrivateKey)(
    input
  ).pipe(Effect.mapError(() => new RecoveryKeyError({ operation: "encode" })));
  const payload = yield* Schema.encodeEffect(Base64Url32)(privateKey).pipe(
    Effect.mapError(() => new RecoveryKeyError({ operation: "encode" }))
  );
  return `${RECOVERY_KEY_PREFIX}${payload}_${checksum(privateKey)}`;
});

export const decodeRecoveryKeyV1 = Effect.fn(
  "@qop/identity/decodeRecoveryKeyV1"
)(function* (input: unknown) {
  const encoded = yield* Schema.decodeUnknownEffect(RecoveryKeyV1String)(
    input
  ).pipe(Effect.mapError(() => new RecoveryKeyError({ operation: "decode" })));
  const payload = encoded.slice(
    RECOVERY_KEY_PREFIX.length,
    RECOVERY_KEY_PREFIX.length + RECOVERY_KEY_PAYLOAD_LENGTH
  );
  const encodedChecksum = encoded.slice(-RECOVERY_KEY_CHECKSUM_LENGTH);
  const privateKey = yield* Schema.decodeUnknownEffect(Base64Url32)(
    payload
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(OwnerPrivateKey)),
    Effect.mapError(() => new RecoveryKeyError({ operation: "decode" }))
  );
  if (checksum(privateKey) !== encodedChecksum) {
    return yield* new RecoveryKeyError({ operation: "decode" });
  }
  return privateKey;
});

export const ownerAddressFromRecoveryKeyV1 = Effect.fn(
  "@qop/identity/ownerAddressFromRecoveryKeyV1"
)(function* (input: unknown) {
  const privateKey = yield* decodeRecoveryKeyV1(input);
  return yield* Effect.try({
    catch: () => new RecoveryKeyError({ operation: "derive-owner" }),
    try: () => privateKeyToAccount(toHex(privateKey)).address.toLowerCase(),
  });
});
