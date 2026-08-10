import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { Data, Effect, Schema } from "effect";
import { keccak256 } from "viem";
import type { Hash } from "viem";

import {
  Base64Url32,
  Base64Url64,
  Hex32,
  PeerId,
  Qid,
  UnixSeconds,
} from "./wire-codecs.ts";

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;
const ED25519_PEER_ID_PREFIX_LENGTH = 6;
const DEVICE_SESSION_POP_DOMAIN_BYTES = Uint8Array.from(
  [..."qop/device-session-pop/v1"].map((character) =>
    character.codePointAt(0)
  ) as number[]
);

export const deviceSessionPopDomain = "qop/device-session-pop/v1" as const;
export const deviceSessionPopVersion = 1 as const;
export const DeviceSessionChallengeV1 = Schema.Struct({
  certificateDigest: Hex32,
  challenge: Base64Url32,
  expiresAt: UnixSeconds,
  issuedAt: UnixSeconds,
  peerId: PeerId,
  qid: Qid,
  verifier: Base64Url32,
  version: Schema.Literal(deviceSessionPopVersion),
})
  .annotate({
    messageUnexpectedKey: "Unexpected device session challenge field",
    parseOptions: strictParseOptions,
  })
  .check(
    Schema.makeFilter((challenge) => challenge.expiresAt > challenge.issuedAt, {
      expected: "expiresAt later than issuedAt",
    })
  )
  .annotate({ parseOptions: strictParseOptions });

export type DeviceSessionChallengeV1 = typeof DeviceSessionChallengeV1.Type;
export type DeviceSessionChallengeV1Encoded =
  typeof DeviceSessionChallengeV1.Encoded;

export const DeviceSessionProofV1 = Schema.Struct({
  challenge: DeviceSessionChallengeV1,
  signature: Base64Url64,
  version: Schema.Literal(deviceSessionPopVersion),
}).annotate({
  messageUnexpectedKey: "Unexpected device session proof field",
  parseOptions: strictParseOptions,
});

export type DeviceSessionProofV1 = typeof DeviceSessionProofV1.Type;
export type DeviceSessionProofV1Encoded = typeof DeviceSessionProofV1.Encoded;

export class DeviceSessionPopCryptoError extends Data.TaggedError(
  "DeviceSessionPopCryptoError"
)<{
  readonly cause?: unknown;
  readonly operation: "derive-peer-id" | "sign" | "verify";
}> {}

const bigintToBytes = (value: bigint, length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  let remaining = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    bytes[index] = Number(remaining % 256n);
    remaining /= 256n;
  }
  return bytes;
};

const concatBytes = (parts: readonly Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0)
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

export const decodeDeviceSessionChallengeV1 = Effect.fn(
  "@qop/identity/decodeDeviceSessionChallengeV1"
)((input: unknown) =>
  Schema.decodeUnknownEffect(DeviceSessionChallengeV1)(input)
);

export const encodeDeviceSessionChallengeV1 = Effect.fn(
  "@qop/identity/encodeDeviceSessionChallengeV1"
)((challenge: DeviceSessionChallengeV1) =>
  Schema.encodeEffect(DeviceSessionChallengeV1)(challenge)
);

export const decodeDeviceSessionProofV1 = Effect.fn(
  "@qop/identity/decodeDeviceSessionProofV1"
)((input: unknown) => Schema.decodeUnknownEffect(DeviceSessionProofV1)(input));

export const encodeDeviceSessionProofV1 = Effect.fn(
  "@qop/identity/encodeDeviceSessionProofV1"
)((proof: DeviceSessionProofV1) =>
  Schema.encodeEffect(DeviceSessionProofV1)(proof)
);

export const hashDeviceSessionChallengeV1 = Effect.fn(
  "@qop/identity/hashDeviceSessionChallengeV1"
)((challenge: DeviceSessionChallengeV1) =>
  Effect.sync(() => {
    const payload = concatBytes([
      DEVICE_SESSION_POP_DOMAIN_BYTES,
      Uint8Array.of(0, deviceSessionPopVersion),
      bigintToBytes(challenge.qid, 32),
      challenge.peerId,
      challenge.certificateDigest,
      challenge.verifier,
      challenge.challenge,
      bigintToBytes(challenge.issuedAt, 8),
      bigintToBytes(challenge.expiresAt, 8),
    ]);
    return keccak256(payload) as Hash;
  })
);

export const peerIdFromEd25519SecretKey = Effect.fn(
  "@qop/identity/peerIdFromEd25519SecretKey"
)(function* (secretKey: Uint8Array) {
  if (secretKey.length !== 32) {
    return yield* new DeviceSessionPopCryptoError({
      operation: "derive-peer-id",
    });
  }
  return yield* Effect.try({
    catch: (cause) =>
      new DeviceSessionPopCryptoError({ cause, operation: "derive-peer-id" }),
    try: () => {
      const publicKey = ed25519.getPublicKey(secretKey);
      return base58.encode(
        Uint8Array.from([0, 36, 8, 1, 18, 32, ...publicKey])
      );
    },
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(PeerId)));
});

export const signDeviceSessionChallengeV1 = Effect.fn(
  "@qop/identity/signDeviceSessionChallengeV1"
)(function* (secretKey: Uint8Array, challenge: DeviceSessionChallengeV1) {
  const expectedPeerId = yield* peerIdFromEd25519SecretKey(secretKey);
  const encodedExpectedPeerId =
    yield* Schema.encodeEffect(PeerId)(expectedPeerId);
  const encodedChallengePeerId = yield* Schema.encodeEffect(PeerId)(
    challenge.peerId
  );
  if (encodedExpectedPeerId !== encodedChallengePeerId) {
    return yield* new DeviceSessionPopCryptoError({ operation: "sign" });
  }
  const digest = yield* hashDeviceSessionChallengeV1(challenge);
  return yield* Effect.try({
    catch: (cause) =>
      new DeviceSessionPopCryptoError({ cause, operation: "sign" }),
    try: () => ed25519.sign(digest.slice(2), secretKey),
  });
});

export const verifyDeviceSessionProofV1 = Effect.fn(
  "@qop/identity/verifyDeviceSessionProofV1"
)(function* (proof: DeviceSessionProofV1) {
  const digest = yield* hashDeviceSessionChallengeV1(proof.challenge);
  const publicKey = proof.challenge.peerId.subarray(
    ED25519_PEER_ID_PREFIX_LENGTH
  );
  return yield* Effect.try({
    catch: (cause) =>
      new DeviceSessionPopCryptoError({ cause, operation: "verify" }),
    try: () =>
      ed25519.verify(proof.signature, digest.slice(2), publicKey, {
        zip215: false,
      }),
  });
});
