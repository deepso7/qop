import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";

import {
  Base64Url32,
  Base64Url64,
  decodeDeviceSessionChallengeV1,
  decodeDeviceSessionProofV1,
  DeviceSessionPopCryptoError,
  encodeDeviceSessionChallengeV1,
  encodeDeviceSessionProofV1,
  hashDeviceSessionChallengeV1,
  Hex32,
  peerIdFromEd25519SecretKey,
  PeerId,
  signDeviceSessionChallengeV1,
  verifyDeviceSessionProofV1,
} from "../src/index.ts";

const PEER_ID = "12D3KooWEyoppNCUx8Yx66oV9fJnriXwCcXwDDUA2kj6vnc6iDEp";
const CHALLENGE = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const CERTIFICATE_DIGEST = `0x${"11".repeat(32)}`;
const EXPECTED_DIGEST =
  "0x8aa7a01cbf95f9247d749eae4ad6ad3a7aad0911521acb06a2255c7a8f724488";
const EXPECTED_SIGNATURE =
  "NbFinYMwpzatJkXXgQKavVuP9A_mgXHCfjqLrY2l-V0SVIO9Oj6Uoa_19TefumryLGMAWw02tr-YjDy993sqDQ";

const secretKey = new Uint8Array(32);
secretKey[31] = 1;

const encodedChallenge = {
  certificateDigest: CERTIFICATE_DIGEST,
  challenge: CHALLENGE,
  expiresAt: "1700000300",
  flow: "registration",
  issuedAt: "1700000000",
  peerId: PEER_ID,
  qid: "42",
  version: 1,
} as const;

describe("device session proof of possession", () => {
  it.effect(
    "pins MiniP2P PeerId, transcript digest, and signature vectors",
    () =>
      Effect.gen(function* () {
        const peerId = yield* peerIdFromEd25519SecretKey(secretKey);
        assert.strictEqual(yield* Schema.encodeEffect(PeerId)(peerId), PEER_ID);

        const challenge =
          yield* decodeDeviceSessionChallengeV1(encodedChallenge);
        const digest = yield* hashDeviceSessionChallengeV1(challenge);
        assert.strictEqual(digest, EXPECTED_DIGEST);

        const signature = yield* signDeviceSessionChallengeV1(
          secretKey,
          challenge
        );
        assert.strictEqual(
          yield* Schema.encodeEffect(Base64Url64)(signature),
          EXPECTED_SIGNATURE
        );

        const proof = yield* decodeDeviceSessionProofV1({
          challenge: encodedChallenge,
          signature: EXPECTED_SIGNATURE,
          version: 1,
        });
        assert.isTrue(yield* verifyDeviceSessionProofV1(proof));
        assert.deepStrictEqual(yield* encodeDeviceSessionProofV1(proof), {
          challenge: encodedChallenge,
          signature: EXPECTED_SIGNATURE,
          version: 1,
        });
        assert.deepStrictEqual(
          yield* encodeDeviceSessionChallengeV1(challenge),
          encodedChallenge
        );
      })
  );

  it.effect("separates flows and every identity binding in the digest", () =>
    Effect.gen(function* () {
      const challenge = yield* decodeDeviceSessionChallengeV1(encodedChallenge);
      const baseline = yield* hashDeviceSessionChallengeV1(challenge);
      const otherSecret = new Uint8Array(32);
      otherSecret[31] = 2;
      const otherPeerId = yield* peerIdFromEd25519SecretKey(otherSecret).pipe(
        Effect.flatMap(Schema.encodeEffect(PeerId))
      );
      const candidates = [
        { ...encodedChallenge, flow: "pairing" as const },
        { ...encodedChallenge, qid: "43" },
        { ...encodedChallenge, peerId: otherPeerId },
        { ...encodedChallenge, certificateDigest: `0x${"22".repeat(32)}` },
        {
          ...encodedChallenge,
          challenge: yield* Schema.encodeEffect(Base64Url32)(
            new Uint8Array(32).fill(9)
          ),
        },
        { ...encodedChallenge, issuedAt: "1700000001" },
        { ...encodedChallenge, expiresAt: "1700000301" },
      ];

      for (const candidate of candidates) {
        const decoded = yield* decodeDeviceSessionChallengeV1(candidate);
        assert.notStrictEqual(
          yield* hashDeviceSessionChallengeV1(decoded),
          baseline
        );
      }
    })
  );

  it.effect("rejects tampering and signing with a different PeerId key", () =>
    Effect.gen(function* () {
      const proof = yield* decodeDeviceSessionProofV1({
        challenge: encodedChallenge,
        signature: EXPECTED_SIGNATURE,
        version: 1,
      });
      const tampered = {
        ...proof,
        challenge: {
          ...proof.challenge,
          certificateDigest: yield* Schema.decodeUnknownEffect(Hex32)(
            `0x${"22".repeat(32)}`
          ),
        },
      };
      assert.isFalse(yield* verifyDeviceSessionProofV1(tampered));

      const otherSecret = new Uint8Array(32);
      otherSecret[31] = 2;
      const signError = yield* signDeviceSessionChallengeV1(
        otherSecret,
        proof.challenge
      ).pipe(Effect.flip);
      assert.instanceOf(signError, DeviceSessionPopCryptoError);
      assert.strictEqual(signError.operation, "sign");
    })
  );

  it.effect(
    "rejects expired ordering, nested versions, and excess fields",
    () =>
      Effect.gen(function* () {
        const expired = yield* decodeDeviceSessionChallengeV1({
          ...encodedChallenge,
          expiresAt: "1700000000",
        }).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(expired));
        if (Exit.isFailure(expired)) {
          assert.include(
            String(expired.cause),
            "Expected expiresAt later than issuedAt"
          );
        }

        const excess = yield* decodeDeviceSessionChallengeV1({
          ...encodedChallenge,
          unexpected: true,
        }).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(excess));
        if (Exit.isFailure(excess)) {
          assert.include(
            String(excess.cause),
            'Unexpected device session challenge field\n  at ["unexpected"]'
          );
        }

        const nestedVersion = yield* decodeDeviceSessionProofV1({
          challenge: { ...encodedChallenge, version: 2 },
          signature: EXPECTED_SIGNATURE,
          version: 1,
        }).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(nestedVersion));
        if (Exit.isFailure(nestedVersion)) {
          assert.include(String(nestedVersion.cause), "Expected 1");
        }
      })
  );

  it.effect("rejects non-canonical and malformed Ed25519 signatures", () =>
    Effect.gen(function* () {
      const candidates = [
        `${"A".repeat(85)}B`,
        `${"A".repeat(86)}==`,
        "A".repeat(85),
      ];

      for (const signature of candidates) {
        const direct = yield* Schema.decodeUnknownEffect(Base64Url64)(
          signature
        ).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(direct));

        const nested = yield* decodeDeviceSessionProofV1({
          challenge: encodedChallenge,
          signature,
          version: 1,
        }).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(nested));
        if (Exit.isFailure(nested)) {
          assert.include(String(nested.cause), '["signature"]');
        }
      }
    })
  );
});
