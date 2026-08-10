import { base58, base64urlnopad, hex } from "@scure/base";
import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect";

const ED25519_PEER_ID_LENGTH = 38;
const ED25519_PEER_ID_STRING_LENGTH = 52;
const ED25519_PEER_ID_PREFIX = Uint8Array.from([0, 36, 8, 1, 18, 32]);
// oxlint-disable unicorn/numeric-separators-style -- Keep the standard secp256k1 constant recognizable.
const SECP256K1_HALF_ORDER =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
// oxlint-enable unicorn/numeric-separators-style
const SECP256K1_ORDER = SECP256K1_HALF_ORDER * 2n + 1n;
const UINT64_MAX = 2n ** 64n - 1n;
const UINT256_MAX = 2n ** 256n - 1n;

const hasEd25519PeerIdPrefix = (bytes: Uint8Array): boolean => {
  if (bytes.length !== ED25519_PEER_ID_LENGTH) {
    return false;
  }

  return ED25519_PEER_ID_PREFIX.every((byte, index) => bytes[index] === byte);
};

const bytesToBigInt = (bytes: Uint8Array): bigint => {
  let value = 0n;
  for (const byte of bytes) {
    value = value * 256n + BigInt(byte);
  }
  return value;
};

const isCanonicalEcdsaSignature = (bytes: Uint8Array): boolean => {
  if (bytes.length !== 65 || (bytes[64] !== 0 && bytes[64] !== 1)) {
    return false;
  }

  const r = bytesToBigInt(bytes.subarray(0, 32));
  const s = bytesToBigInt(bytes.subarray(32, 64));
  return r > 0n && r < SECP256K1_ORDER && s > 0n && s <= SECP256K1_HALF_ORDER;
};

const Bytes32 = Schema.Uint8Array.check(
  Schema.makeFilter((bytes) => bytes.length === 32, {
    expected: "exactly 32 bytes",
  })
);

const Bytes64 = Schema.Uint8Array.check(
  Schema.makeFilter((bytes) => bytes.length === 64, {
    expected: "exactly 64 bytes",
  })
);

const CanonicalHex32String = Schema.String.check(
  Schema.isPattern(/^0x[0-9a-f]{64}$/u, {
    expected: "a lowercase 32-byte 0x-prefixed hex string",
  })
);

export const Hex32 = CanonicalHex32String.pipe(
  Schema.decodeTo(
    Bytes32,
    SchemaTransformation.transform({
      decode: (value) => hex.decode(value.slice(2)),
      encode: (value) => `0x${hex.encode(value)}`,
    })
  )
);

const CanonicalBase64Url32 = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u, {
    expected: "an unpadded 43-character base64url string",
  })
).annotate({
  expected: "an unpadded base64url string encoding exactly 32 bytes",
});

export const Base64Url32 = CanonicalBase64Url32.pipe(
  Schema.decodeTo(
    Bytes32,
    SchemaTransformation.transformOrFail({
      decode: (value) =>
        Effect.try({
          catch: () =>
            new SchemaIssue.InvalidValue({
              message: "Expected canonical unpadded base64url",
            }),
          try: () => {
            const bytes = base64urlnopad.decode(value);
            if (base64urlnopad.encode(bytes) !== value) {
              throw new Error("Non-canonical base64url encoding");
            }
            return bytes;
          },
        }),
      encode: (value) => Effect.succeed(base64urlnopad.encode(value)),
    })
  )
);

const CanonicalBase64Url64 = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{86}$/u, {
    expected: "an unpadded 86-character base64url string",
  })
).annotate({
  expected: "an unpadded base64url string encoding exactly 64 bytes",
});

export const Base64Url64 = CanonicalBase64Url64.pipe(
  Schema.decodeTo(
    Bytes64,
    SchemaTransformation.transformOrFail({
      decode: (value) =>
        Effect.try({
          catch: () =>
            new SchemaIssue.InvalidValue({
              message: "Expected canonical unpadded base64url",
            }),
          try: () => {
            const bytes = base64urlnopad.decode(value);
            if (base64urlnopad.encode(bytes) !== value) {
              throw new Error("Non-canonical base64url encoding");
            }
            return bytes;
          },
        }),
      encode: (value) => Effect.succeed(base64urlnopad.encode(value)),
    })
  )
);

const PeerIdBytes = Schema.Uint8Array.check(
  Schema.makeFilter(hasEd25519PeerIdPrefix, {
    expected: "canonical MiniP2P Ed25519 PeerId bytes",
  })
);

const PeerIdString = Schema.String.check(
  Schema.isLengthBetween(
    ED25519_PEER_ID_STRING_LENGTH,
    ED25519_PEER_ID_STRING_LENGTH,
    { expected: "a 52-character PeerId" }
  ),
  Schema.isPattern(
    /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/u,
    { expected: "the base58 alphabet" }
  )
).annotate({
  expected: "a canonical 52-character MiniP2P Ed25519 PeerId in base58",
});

export const PeerId = PeerIdString.pipe(
  Schema.decodeTo(
    PeerIdBytes,
    SchemaTransformation.transform({
      decode: base58.decode,
      encode: base58.encode,
    })
  )
);

const CanonicalEcdsaSignatureString = Schema.String.check(
  Schema.isPattern(/^0x[0-9a-f]{130}$/u, {
    expected: "a lowercase 65-byte 0x-prefixed ECDSA signature",
  })
).annotate({
  expected: "a canonical lowercase 65-byte 0x-prefixed ECDSA signature",
});

const EcdsaSignatureBytes = Schema.Uint8Array.check(
  Schema.makeFilter(isCanonicalEcdsaSignature, {
    expected: "an ECDSA signature with valid r, low-s, and yParity 0 or 1",
  })
);

export const EcdsaSignature = CanonicalEcdsaSignatureString.pipe(
  Schema.decodeTo(
    EcdsaSignatureBytes,
    SchemaTransformation.transform({
      decode: (value) => hex.decode(value.slice(2)),
      encode: (value) => `0x${hex.encode(value)}`,
    })
  )
);

const WalletEcdsaSignatureString = Schema.String.check(
  Schema.isPattern(/^0x[0-9a-f]{128}(?:00|01|1b|1c)$/iu, {
    expected: "a 65-byte ECDSA signature ending in yParity 0/1 or v 27/28",
  })
);

export const normalizeEcdsaSignature = Effect.fn(
  "@qop/identity/normalizeEcdsaSignature"
)((input: unknown) =>
  Schema.decodeUnknownEffect(WalletEcdsaSignatureString)(input).pipe(
    Effect.map((signature) => {
      const bytes = hex.decode(signature.toLowerCase().slice(2));
      const recovery = bytes.at(-1);
      if (recovery === 27 || recovery === 28) {
        bytes[64] = recovery - 27;
      }
      return `0x${hex.encode(bytes)}`;
    }),
    Effect.flatMap(Schema.decodeUnknownEffect(EcdsaSignature))
  )
);

const CanonicalUint256String = Schema.String.check(
  Schema.isMaxLength(78, { expected: "at most 78 decimal digits" }),
  Schema.isPattern(/^(?:0|[1-9][0-9]*)$/u, {
    expected: "a canonical uint256 decimal string",
  })
).annotate({ expected: "a canonical uint256 decimal string" });

const Uint256Value = Schema.BigInt.check(
  Schema.makeFilter((value) => value >= 0n && value <= UINT256_MAX, {
    expected: "a uint256",
  })
);

const PositiveQid = Schema.BigInt.check(
  Schema.makeFilter((value) => value > 0n && value <= UINT256_MAX, {
    expected: "a positive uint256 qid",
  })
);

const PositiveChainId = Schema.BigInt.check(
  Schema.makeFilter((value) => value > 0n && value <= UINT256_MAX, {
    expected: "a positive uint256 chain id",
  })
);

const CanonicalUint64String = Schema.String.check(
  Schema.isMaxLength(20, { expected: "at most 20 decimal digits" }),
  Schema.isPattern(/^(?:0|[1-9][0-9]*)$/u, {
    expected: "a canonical uint64 decimal string",
  })
).annotate({ expected: "a canonical uint64 decimal string" });

const Uint64 = Schema.BigInt.check(
  Schema.makeFilter((value) => value >= 0n && value <= UINT64_MAX, {
    expected: "a uint64 Unix timestamp",
  })
);

export const Qid = CanonicalUint256String.pipe(
  Schema.decodeTo(PositiveQid, SchemaTransformation.bigintFromString)
);

export const Uint256 = CanonicalUint256String.pipe(
  Schema.decodeTo(Uint256Value, SchemaTransformation.bigintFromString)
);

export const ChainId = CanonicalUint256String.pipe(
  Schema.decodeTo(PositiveChainId, SchemaTransformation.bigintFromString)
);

export const UnixSeconds = CanonicalUint64String.pipe(
  Schema.decodeTo(Uint64, SchemaTransformation.bigintFromString)
);

export const EthereumAddress = Schema.String.check(
  Schema.isPattern(/^0x[0-9a-f]{40}$/u, {
    expected: "a canonical lowercase Ethereum address",
  })
);

const EthereumAddressInput = Schema.String.check(
  Schema.isPattern(/^0x[0-9a-f]{40}$/iu, {
    expected: "a 20-byte 0x-prefixed Ethereum address",
  })
);

export const normalizeEthereumAddress = Effect.fn(
  "@qop/identity/normalizeEthereumAddress"
)((input: unknown) =>
  Schema.decodeUnknownEffect(EthereumAddressInput)(input).pipe(
    Effect.map((address) => address.toLowerCase()),
    Effect.flatMap(Schema.decodeUnknownEffect(EthereumAddress))
  )
);

export const Handle = Schema.String.check(
  Schema.isLengthBetween(1, 32, {
    expected: "a handle between 1 and 32 characters",
  }),
  Schema.isPattern(/^[a-z]+$/u, {
    expected: "a handle containing only lowercase ASCII letters",
  })
);
