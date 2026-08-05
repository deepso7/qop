import { assert, describe, it } from "@effect/vitest";
import { hex } from "@scure/base";
import { Effect, Exit, Schema, SchemaIssue } from "effect";

import {
  Base64Url32,
  decodeIdentityEnvelopeV1,
  EcdsaSignature,
  encodeIdentityEnvelopeV1,
  IdentityEnvelopeV1,
  PeerId,
  Qid,
  UnixSeconds,
} from "../src/index.ts";

const RELAY_PEER_ID = "12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X";

// oxlint-disable unicorn/prefer-bigint-literals -- Keep standard secp256k1 constants recognizable in tests.
const SECP256K1_HALF_ORDER = BigInt(
  "0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0"
);
const SECP256K1_ORDER = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"
);
// oxlint-enable unicorn/prefer-bigint-literals

interface SignatureParts {
  readonly r?: bigint;
  readonly s?: bigint;
  readonly yParity?: 0 | 1;
}

const makeSignature = ({
  r = 1n,
  s = 1n,
  yParity = 0,
}: SignatureParts = {}): string => {
  const encodedR = r.toString(16).padStart(64, "0");
  const encodedS = s.toString(16).padStart(64, "0");
  const encodedParity = yParity.toString(16).padStart(2, "0");
  return `0x${encodedR}${encodedS}${encodedParity}`;
};

const validEnvelope = {
  certificate: {
    encryptionPublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    issuedAt: "1",
    ownerVersion: 0,
    peerId: RELAY_PEER_ID,
    qid: "1",
    salt: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
    version: 1,
  },
  signature: makeSignature(),
  version: 1,
} as const;

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

const expectEnvelopeIssue = Effect.fn("@qop/identity/test/expectEnvelopeIssue")(
  function* (input: unknown, path: readonly string[], message: string) {
    const error = yield* decodeIdentityEnvelopeV1(input).pipe(Effect.flip);
    assert.deepStrictEqual(formatIssue(error.issue).issues, [
      { message, path },
    ]);
  }
);

describe("identity wire codecs", () => {
  it.effect("round-trips a canonical MiniP2P PeerId golden vector", () =>
    Effect.gen(function* () {
      const bytes = yield* Schema.decodeUnknownEffect(PeerId)(RELAY_PEER_ID);
      assert.strictEqual(bytes.length, 38);
      assert.strictEqual(
        hex.encode(bytes),
        "002408011220cecc1507dc1ddd7295951c290888f095adb9044d1b73d696e6df065d683bd4fc"
      );

      const encoded = yield* Schema.encodeEffect(PeerId)(bytes);
      assert.strictEqual(encoded, RELAY_PEER_ID);
    })
  );

  it.effect("rejects alternate and oversized PeerId representations", () =>
    Effect.gen(function* () {
      for (const peerId of [
        `z${RELAY_PEER_ID}`,
        `1${RELAY_PEER_ID}`,
        RELAY_PEER_ID.replace("K", "0"),
        "1".repeat(10_000),
      ]) {
        const exit = yield* Effect.exit(
          Schema.decodeUnknownEffect(PeerId)(peerId)
        );
        assert.isTrue(Exit.isFailure(exit));
      }
    })
  );

  it.effect("accepts only canonical unpadded 32-byte base64url", () =>
    Effect.gen(function* () {
      const canonical = validEnvelope.certificate.encryptionPublicKey;
      const bytes = yield* Schema.decodeUnknownEffect(Base64Url32)(canonical);
      assert.strictEqual(bytes.length, 32);

      const encoded = yield* Schema.encodeEffect(Base64Url32)(bytes);
      assert.strictEqual(encoded, canonical);

      const finalByteSet = new Uint8Array(32);
      finalByteSet[31] = 1;
      const canonicalNonzeroTail =
        yield* Schema.encodeEffect(Base64Url32)(finalByteSet);
      assert.strictEqual(canonicalNonzeroTail.slice(-3), "AAE");
      assert.deepStrictEqual(
        yield* Schema.decodeUnknownEffect(Base64Url32)(canonicalNonzeroTail),
        finalByteSet
      );

      for (const value of [
        `${canonical.slice(0, -1)}B`,
        `${canonical}=`,
        canonical.slice(1),
        `${canonical}A`,
      ]) {
        const exit = yield* Effect.exit(
          Schema.decodeUnknownEffect(Base64Url32)(value)
        );
        assert.isTrue(Exit.isFailure(exit));
      }
    })
  );

  it.effect(
    "bounds canonical qids and timestamps before bigint conversion",
    () =>
      Effect.gen(function* () {
        const uint256Max = (2n ** 256n - 1n).toString();
        const uint64Max = (2n ** 64n - 1n).toString();

        assert.strictEqual(
          yield* Schema.decodeUnknownEffect(Qid)(uint256Max),
          2n ** 256n - 1n
        );
        assert.strictEqual(
          yield* Schema.decodeUnknownEffect(UnixSeconds)(uint64Max),
          2n ** 64n - 1n
        );

        for (const [schema, value] of [
          [Qid, (2n ** 256n).toString()],
          [Qid, "9".repeat(10_000)],
          [UnixSeconds, (2n ** 64n).toString()],
          [UnixSeconds, "9".repeat(10_000)],
        ] as const) {
          const exit = yield* Effect.exit(
            Schema.decodeUnknownEffect(schema)(value)
          );
          assert.isTrue(Exit.isFailure(exit));
        }
      })
  );

  it.effect("enforces ECDSA r, low-s, and yParity bounds", () =>
    Effect.gen(function* () {
      for (const signature of [
        makeSignature(),
        makeSignature({ r: SECP256K1_ORDER - 1n }),
        makeSignature({ s: SECP256K1_HALF_ORDER }),
      ]) {
        const decoded =
          yield* Schema.decodeUnknownEffect(EcdsaSignature)(signature);
        assert.strictEqual(decoded.length, 65);
      }

      const invalidSignatures = [
        makeSignature({ r: 0n }),
        makeSignature({ r: SECP256K1_ORDER }),
        makeSignature({ r: SECP256K1_ORDER + 1n }),
        makeSignature({ s: 0n }),
        makeSignature({ s: SECP256K1_HALF_ORDER + 1n }),
        `${validEnvelope.signature.slice(0, -2)}1b`,
        `${validEnvelope.signature.slice(0, 2)}A${validEnvelope.signature.slice(3)}`,
      ];

      for (const candidate of invalidSignatures) {
        const exit = yield* Effect.exit(
          Schema.decodeUnknownEffect(EcdsaSignature)(candidate)
        );
        assert.isTrue(Exit.isFailure(exit));
      }
    })
  );

  it.effect("decodes and re-encodes the versioned identity envelope", () =>
    Effect.gen(function* () {
      const envelope = yield* decodeIdentityEnvelopeV1(validEnvelope);
      assert.strictEqual(envelope.certificate.qid, 1n);
      assert.strictEqual(envelope.certificate.peerId.length, 38);
      assert.strictEqual(envelope.signature.length, 65);

      const encoded = yield* encodeIdentityEnvelopeV1(envelope);
      assert.deepStrictEqual(encoded, validEnvelope);
    })
  );

  it.effect("rejects a zero qid for the named qid constraint", () =>
    expectEnvelopeIssue(
      {
        ...validEnvelope,
        certificate: { ...validEnvelope.certificate, qid: "0" },
      },
      ["certificate", "qid"],
      "Expected a positive uint256 qid"
    )
  );

  it.effect("rejects a noncanonical qid at the qid path", () =>
    expectEnvelopeIssue(
      {
        ...validEnvelope,
        certificate: { ...validEnvelope.certificate, qid: "01" },
      },
      ["certificate", "qid"],
      "Expected a canonical uint256 decimal string"
    )
  );

  it.effect("rejects a mismatched envelope version", () =>
    expectEnvelopeIssue(
      { ...validEnvelope, version: 2 },
      ["version"],
      "Expected 1"
    )
  );

  it.effect("rejects a mismatched nested certificate version", () =>
    expectEnvelopeIssue(
      {
        ...validEnvelope,
        certificate: { ...validEnvelope.certificate, version: 2 },
      },
      ["certificate", "version"],
      "Expected 1"
    )
  );

  it.effect("rejects an owner version outside uint32", () =>
    expectEnvelopeIssue(
      {
        ...validEnvelope,
        certificate: {
          ...validEnvelope.certificate,
          ownerVersion: 4_294_967_296,
        },
      },
      ["certificate", "ownerVersion"],
      "Expected a value between 0 and 4294967295"
    )
  );

  it.effect("keeps raw exported schemas strict at every level", () =>
    Effect.gen(function* () {
      const topLevelError = yield* Schema.decodeUnknownEffect(
        IdentityEnvelopeV1
      )({ ...validEnvelope, unexpected: true }).pipe(Effect.flip);
      assert.deepStrictEqual(formatIssue(topLevelError.issue).issues, [
        {
          message: "Unexpected identity envelope field",
          path: ["unexpected"],
        },
      ]);

      const nestedError = yield* Schema.decodeUnknownEffect(IdentityEnvelopeV1)(
        {
          ...validEnvelope,
          certificate: { ...validEnvelope.certificate, unexpected: true },
        }
      ).pipe(Effect.flip);
      assert.deepStrictEqual(formatIssue(nestedError.issue).issues, [
        {
          message: "Unexpected device certificate field",
          path: ["certificate", "unexpected"],
        },
      ]);
    })
  );
});
