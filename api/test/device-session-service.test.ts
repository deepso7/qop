import { assert, layer } from "@effect/vitest";
import {
  Base64Url32,
  Base64Url64,
  decodeDeviceSessionChallengeV1,
  encodeDeviceSessionProofV1,
  peerIdFromEd25519SecretKey,
  PeerId,
  signDeviceSessionChallengeV1,
} from "@qop/identity";
import { DateTime, Duration, Effect, Layer, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import { keccak256 } from "viem";
import type { Address, Hash, Hex } from "viem";

import {
  DeviceSessionCertificateRejected,
  DeviceSessionChallengeBindingMismatch,
  DeviceSessionProofInvalid,
  DeviceSessionProtocolError,
  DeviceSessionService,
} from "../src/device-session/service.ts";
import {
  DeviceSessionChallengeConsumed,
  DeviceSessionChallengeExpired,
  DeviceSessionExpired,
  DeviceSessionNotFound,
  DeviceSessionStore,
} from "../src/device-session/store.ts";
import { DeviceCertificateStore } from "../src/device/store.ts";
import { Entropy } from "../src/entropy.ts";
import { Env } from "../src/env.ts";
import { RegistrationStore } from "../src/registration/store.ts";
import { RegistryReader } from "../src/registry/reader.ts";
import type {
  RegistryInvalidations,
  RegistryRead,
  RegistryReads,
} from "../src/registry/reader.ts";
import { DeviceAndRegistrationStoresTestLive } from "./support/registration-database.ts";

const OWNER = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf" as Address;
const SIGNATURE = `0x${"1".padStart(64, "0")}${"1".padStart(64, "0")}00` as Hex;
const gatewayId = new Uint8Array(32);
const secretKey = new Uint8Array(32);
secretKey[31] = 1;
const peerId = Effect.runSync(
  peerIdFromEd25519SecretKey(secretKey).pipe(
    Effect.flatMap(Schema.encodeEffect(PeerId))
  )
);

const hash = (value: number): Hash =>
  `0x${value.toString(16).padStart(64, "0")}` as Hash;

const read = <Value>(value: Value): RegistryRead<Value> => ({
  blockNumber: 100n,
  cachedAt: 0,
  freshness: "fresh",
  value,
});

let registryOwnerVersion = 0;
let revokedDigest: Hash | undefined;
let entropyCounter = 0;

const registryReads: RegistryReads = {
  account: (qid) =>
    Effect.succeed(
      read({
        handle: "alice",
        nonce: 0n,
        owner: OWNER,
        ownerVersion: registryOwnerVersion,
        qid,
        registeredAt: 0n,
      })
    ),
  deviceRevocation: (_qid, digest) =>
    Effect.succeed(read(digest === revokedDigest)),
  qidByHandle: () => Effect.die("not used by device session tests"),
  qidByOwner: () => Effect.die("not used by device session tests"),
};

const registryInvalidations: RegistryInvalidations = {
  account: () => Effect.void,
  all: Effect.void,
  deviceRevocation: () => Effect.void,
  ownerRotation: () => Effect.void,
  qidByHandle: () => Effect.void,
  qidByOwner: () => Effect.void,
};

const RegistryReaderTestLive = Layer.succeed(
  RegistryReader,
  RegistryReader.of({
    cached: {
      ...registryReads,
      account: () =>
        Effect.die("device session authorization must use fresh account state"),
      deviceRevocation: () =>
        Effect.die(
          "device session authorization must use fresh revocation state"
        ),
    },
    fresh: {
      ...registryReads,
      registrationProbe: () => Effect.die("not used by device session tests"),
    },
    invalidate: registryInvalidations,
  })
);

const EntropyTestLive = Layer.succeed(
  Entropy,
  Entropy.of({
    bytes32: Effect.sync(() => {
      entropyCounter += 1;
      const bytes = new Uint8Array(32);
      bytes[28] = Math.floor(entropyCounter / 16_777_216) % 256;
      bytes[29] = Math.floor(entropyCounter / 65_536) % 256;
      bytes[30] = Math.floor(entropyCounter / 256) % 256;
      bytes[31] = entropyCounter % 256;
      return bytes;
    }),
  })
);

const EnvTestLive = Layer.succeed(
  Env,
  Env.of({
    CHAIN_ID: 31_337n,
    DATABASE_URL: "postgresql://test",
    GATEWAY_ID: gatewayId,
    PORT: 3000,
    REGISTRATION_PRIVATE_KEY: `0x${"11".repeat(32)}`,
    REGISTRY_ADDRESS: OWNER,
    REGISTRY_CONFIRMATIONS: 0,
    RELAYER_PRIVATE_KEY: `0x${"22".repeat(32)}`,
    RPC_URL: new URL("http://127.0.0.1:8545"),
  })
);

const DeviceSessionServiceTestLive = DeviceSessionService.layer.pipe(
  Layer.provideMerge(DeviceAndRegistrationStoresTestLive),
  Layer.provide(RegistryReaderTestLive),
  Layer.provide(EntropyTestLive),
  Layer.provide(EnvTestLive)
);

const observeCertificate = Effect.fn("test.observeCertificate")(function* (
  id: number,
  expiresInSeconds?: bigint
) {
  const registrations = yield* RegistrationStore;
  const certificates = yield* DeviceCertificateStore;
  const registrationDigest = hash(1000 + id);
  const certificateDigest = hash(2000 + id);
  const qid = BigInt(40 + id);
  const now = yield* DateTime.now;
  const deadline =
    BigInt(Math.floor(DateTime.toEpochMillis(now) / 1000)) + 600n;
  const certificateExpiresAt =
    expiresInSeconds === undefined
      ? 4_000_000_000n
      : BigInt(Math.floor(DateTime.toEpochMillis(now) / 1000)) +
        expiresInSeconds;
  yield* registrations.create({
    admissionCodeHash: hash(6000 + id),
    deadline,
    deviceCommitment: hash(5000 + id),
    digest: registrationDigest,
    handle: `session${String.fromCodePoint(96 + id)}`,
    idempotencyKeyHash: hash(7000 + id),
    observeTokenHash: hash(3000 + id),
    owner: OWNER,
    peerId,
    registrationNonce: hash(4000 + id),
  });
  yield* registrations.authorize(registrationDigest, {
    ownerSignature: SIGNATURE,
    registrationSignature: SIGNATURE,
  });
  yield* registrations.markConfirmed(registrationDigest, qid);
  yield* certificates.observeFromRegistration({
    certificateDigest,
    envelope: {
      certificate: {
        encryptionPublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        expiresAt: certificateExpiresAt.toString(),
        issuedAt: "0",
        ownerVersion: 0,
        peerId,
        qid: qid.toString(),
        salt: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
        version: 1,
      },
      signature: SIGNATURE,
      version: 1,
    },
    registrationIntentDigest: registrationDigest,
  });
  return { certificateDigest, qid };
});

const signChallenge = Effect.fn("test.signChallenge")(function* (
  challenge: unknown
) {
  const decoded = yield* decodeDeviceSessionChallengeV1(challenge);
  const signature = yield* signDeviceSessionChallengeV1(secretKey, decoded);
  return yield* encodeDeviceSessionProofV1({
    challenge: decoded,
    signature,
    version: 1,
  });
});

layer(DeviceSessionServiceTestLive, { timeout: "30 seconds" })((it) => {
  it.effect("issues a bound challenge and consumes one valid proof", () =>
    Effect.gen(function* () {
      registryOwnerVersion = 0;
      revokedDigest = undefined;
      const certificate = yield* observeCertificate(1);
      const sessions = yield* DeviceSessionService;
      const challenge = yield* sessions.issue({
        certificateDigest: certificate.certificateDigest,
      });
      assert.strictEqual(
        challenge.certificateDigest,
        certificate.certificateDigest
      );
      assert.strictEqual(challenge.peerId, peerId);
      assert.strictEqual(challenge.qid, certificate.qid.toString());
      assert.strictEqual(
        challenge.verifier,
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      );
      assert.strictEqual(
        BigInt(challenge.expiresAt) - BigInt(challenge.issuedAt),
        300n
      );
      assert.deepStrictEqual(
        yield* sessions.issue({
          certificateDigest: certificate.certificateDigest,
        }),
        challenge
      );

      const completed = yield* sessions.authenticate(
        yield* signChallenge(challenge)
      );
      assert.strictEqual(
        completed.certificateDigest,
        certificate.certificateDigest
      );
      assert.strictEqual(completed.peerId, peerId);
      assert.strictEqual(completed.qid, certificate.qid);
      assert.deepStrictEqual(yield* sessions.resolve(completed.token), {
        certificateDigest: certificate.certificateDigest,
        peerId,
        qid: certificate.qid,
      });
      assert.strictEqual(
        BigInt(completed.expiresAt) - BigInt(challenge.issuedAt),
        3600n
      );

      registryOwnerVersion = 1;
      const rotated = yield* sessions
        .resolve(completed.token)
        .pipe(Effect.flip);
      assert.instanceOf(rotated, DeviceSessionCertificateRejected);
      assert.strictEqual(rotated.reason, "owner-version");
      registryOwnerVersion = 0;

      revokedDigest = certificate.certificateDigest;
      const revoked = yield* sessions
        .resolve(completed.token)
        .pipe(Effect.flip);
      assert.instanceOf(revoked, DeviceSessionCertificateRejected);
      assert.strictEqual(revoked.reason, "revoked");
      revokedDigest = undefined;

      const malformed = yield* sessions
        .resolve("not-a-token")
        .pipe(Effect.flip);
      assert.instanceOf(malformed, DeviceSessionProtocolError);
      assert.strictEqual(malformed.operation, "decode-token");

      const unknownToken = yield* Schema.encodeEffect(Base64Url32)(
        new Uint8Array(32)
      );
      const unknown = yield* sessions.resolve(unknownToken).pipe(Effect.flip);
      assert.instanceOf(unknown, DeviceSessionNotFound);

      yield* TestClock.adjust(Duration.seconds(3601));
      const expired = yield* sessions
        .resolve(completed.token)
        .pipe(Effect.flip);
      assert.instanceOf(expired, DeviceSessionExpired);
      const store = yield* DeviceSessionStore;
      assert.isAtLeast(yield* store.purgeExpired, 1);
      const purged = yield* sessions.resolve(completed.token).pipe(Effect.flip);
      assert.instanceOf(purged, DeviceSessionNotFound);
    })
  );

  it.effect("stops resolving a session when its certificate expires", () =>
    Effect.gen(function* () {
      registryOwnerVersion = 0;
      revokedDigest = undefined;
      const certificate = yield* observeCertificate(11, 5n);
      const sessions = yield* DeviceSessionService;
      const challenge = yield* sessions.issue({
        certificateDigest: certificate.certificateDigest,
      });
      assert.strictEqual(
        BigInt(challenge.expiresAt) - BigInt(challenge.issuedAt),
        5n
      );
      const completed = yield* sessions.authenticate(
        yield* signChallenge(challenge)
      );
      assert.strictEqual(completed.expiresAt, challenge.expiresAt);

      yield* TestClock.adjust(Duration.seconds(6));
      const expired = yield* sessions
        .resolve(completed.token)
        .pipe(Effect.flip);
      assert.instanceOf(expired, DeviceSessionExpired);
    })
  );

  it.effect("allows only one concurrent proof consumption", () =>
    Effect.gen(function* () {
      registryOwnerVersion = 0;
      revokedDigest = undefined;
      const certificate = yield* observeCertificate(2);
      const sessions = yield* DeviceSessionService;
      const challenge = yield* sessions.issue({
        certificateDigest: certificate.certificateDigest,
      });
      const proof = yield* signChallenge(challenge);
      const results = yield* Effect.all(
        [sessions.authenticate(proof), sessions.authenticate(proof)].map(
          (effect) => effect.pipe(Effect.result)
        ),
        { concurrency: "unbounded" }
      );

      assert.lengthOf(results.filter(Result.isSuccess), 1);
      const failures = results.filter(Result.isFailure);
      assert.lengthOf(failures, 1);
      assert.instanceOf(failures[0]?.failure, DeviceSessionChallengeConsumed);
    })
  );

  it.effect("rejects and replaces challenges from another gateway", () =>
    Effect.gen(function* () {
      gatewayId.fill(0);
      registryOwnerVersion = 0;
      revokedDigest = undefined;
      const certificate = yield* observeCertificate(9);
      const sessions = yield* DeviceSessionService;
      const first = yield* sessions.issue({
        certificateDigest: certificate.certificateDigest,
      });
      const firstProof = yield* signChallenge(first);

      gatewayId[31] = 1;
      const rejected = yield* sessions
        .authenticate(firstProof)
        .pipe(Effect.flip);
      assert.instanceOf(rejected, DeviceSessionChallengeBindingMismatch);

      const replacement = yield* sessions.issue({
        certificateDigest: certificate.certificateDigest,
      });
      assert.notStrictEqual(replacement.challenge, first.challenge);
      assert.notStrictEqual(replacement.verifier, first.verifier);
      const completed = yield* sessions.authenticate(
        yield* signChallenge(replacement)
      );
      assert.strictEqual(
        completed.certificateDigest,
        certificate.certificateDigest
      );
      gatewayId.fill(0);
      assert.instanceOf(
        yield* sessions.resolve(completed.token).pipe(Effect.flip),
        DeviceSessionNotFound
      );
    }).pipe(Effect.ensuring(Effect.sync(() => gatewayId.fill(0))))
  );

  it.effect("rejects expired and tampered proofs", () =>
    Effect.gen(function* () {
      registryOwnerVersion = 0;
      revokedDigest = undefined;
      const certificate = yield* observeCertificate(3);
      const sessions = yield* DeviceSessionService;
      const challenge = yield* sessions.issue({
        certificateDigest: certificate.certificateDigest,
      });
      const proof = yield* signChallenge(challenge);
      yield* TestClock.adjust(Duration.seconds(301));
      const expired = yield* sessions.authenticate(proof).pipe(Effect.flip);
      assert.strictEqual(expired._tag, "DeviceSessionChallengeExpired");

      const secondCertificate = yield* observeCertificate(4);
      const secondChallenge = yield* sessions.issue({
        certificateDigest: secondCertificate.certificateDigest,
      });
      const tampered = yield* sessions
        .authenticate({
          ...(yield* signChallenge(secondChallenge)),
          challenge: { ...secondChallenge, qid: "999" },
        })
        .pipe(Effect.flip);
      assert.instanceOf(tampered, DeviceSessionChallengeBindingMismatch);

      const neverIssuedBytes = new Uint8Array(32).fill(77);
      const neverIssuedChallenge = {
        ...secondChallenge,
        challenge: yield* Schema.encodeEffect(Base64Url32)(neverIssuedBytes),
      };
      const neverIssued = yield* sessions
        .authenticate(yield* signChallenge(neverIssuedChallenge))
        .pipe(Effect.flip);
      assert.instanceOf(neverIssued, DeviceSessionChallengeBindingMismatch);
      assert.strictEqual(
        neverIssued.challengeHash,
        keccak256(neverIssuedBytes)
      );
    })
  );

  it.effect(
    "rejects bad signatures, rotation, revocation, and unknown certs",
    () =>
      Effect.gen(function* () {
        registryOwnerVersion = 0;
        revokedDigest = undefined;
        const sessions = yield* DeviceSessionService;

        const invalidCertificate = yield* observeCertificate(5);
        const invalidChallenge = yield* sessions.issue({
          certificateDigest: invalidCertificate.certificateDigest,
        });
        const invalidProof = yield* signChallenge(invalidChallenge);
        const replacementSignature = new Uint8Array(64);
        const invalid = yield* sessions
          .authenticate({
            ...invalidProof,
            signature:
              yield* Schema.encodeEffect(Base64Url64)(replacementSignature),
          })
          .pipe(Effect.flip);
        assert.instanceOf(invalid, DeviceSessionProofInvalid);

        const rotatedCertificate = yield* observeCertificate(6);
        const rotatedChallenge = yield* sessions.issue({
          certificateDigest: rotatedCertificate.certificateDigest,
        });
        registryOwnerVersion = 1;
        const rotated = yield* sessions
          .authenticate(yield* signChallenge(rotatedChallenge))
          .pipe(Effect.flip);
        assert.instanceOf(rotated, DeviceSessionCertificateRejected);
        assert.strictEqual(rotated.reason, "owner-version");
        const rotatedReplay = yield* sessions
          .authenticate(yield* signChallenge(rotatedChallenge))
          .pipe(Effect.flip);
        assert.instanceOf(rotatedReplay, DeviceSessionChallengeConsumed);
        const rotatedIssue = yield* sessions
          .issue({
            certificateDigest: rotatedCertificate.certificateDigest,
          })
          .pipe(Effect.flip);
        assert.instanceOf(rotatedIssue, DeviceSessionCertificateRejected);
        assert.strictEqual(rotatedIssue.reason, "owner-version");

        registryOwnerVersion = 0;
        const revokedCertificate = yield* observeCertificate(7);
        const revokedChallenge = yield* sessions.issue({
          certificateDigest: revokedCertificate.certificateDigest,
        });
        revokedDigest = revokedCertificate.certificateDigest;
        const revoked = yield* sessions
          .authenticate(yield* signChallenge(revokedChallenge))
          .pipe(Effect.flip);
        assert.instanceOf(revoked, DeviceSessionCertificateRejected);
        assert.strictEqual(revoked.reason, "revoked");
        const revokedReplay = yield* sessions
          .authenticate(yield* signChallenge(revokedChallenge))
          .pipe(Effect.flip);
        assert.instanceOf(revokedReplay, DeviceSessionChallengeConsumed);
        const revokedIssue = yield* sessions
          .issue({
            certificateDigest: revokedCertificate.certificateDigest,
          })
          .pipe(Effect.flip);
        assert.instanceOf(revokedIssue, DeviceSessionCertificateRejected);
        assert.strictEqual(revokedIssue.reason, "revoked");

        revokedDigest = undefined;
        const unknown = yield* sessions
          .issue({ certificateDigest: hash(9999) })
          .pipe(Effect.flip);
        assert.instanceOf(unknown, DeviceSessionCertificateRejected);
        assert.strictEqual(unknown.reason, "not-found");

        const expiringCertificate = yield* observeCertificate(10, 1n);
        yield* TestClock.adjust(Duration.seconds(2));
        const expiredCertificate = yield* sessions
          .issue({
            certificateDigest: expiringCertificate.certificateDigest,
          })
          .pipe(Effect.flip);
        assert.instanceOf(expiredCertificate, DeviceSessionCertificateRejected);
        assert.strictEqual(expiredCertificate.reason, "expired");
      })
  );

  it.effect("classifies store misses and purges expired challenges", () =>
    Effect.gen(function* () {
      registryOwnerVersion = 0;
      revokedDigest = undefined;
      const store = yield* DeviceSessionStore;
      const missingHash = hash(12_345);
      const missing = yield* store
        .consumeChallenge(missingHash)
        .pipe(Effect.flip);
      assert.strictEqual(missing._tag, "DeviceSessionChallengeNotFound");

      const certificate = yield* observeCertificate(8);
      const sessions = yield* DeviceSessionService;
      const challenge = yield* sessions.issue({
        certificateDigest: certificate.certificateDigest,
      });
      const decoded = yield* decodeDeviceSessionChallengeV1(challenge);
      const challengeHash = keccak256(decoded.challenge);
      yield* TestClock.adjust(Duration.seconds(301));
      const expired = yield* store
        .consumeChallenge(challengeHash)
        .pipe(Effect.flip);
      assert.instanceOf(expired, DeviceSessionChallengeExpired);

      assert.isAtLeast(yield* store.purgeExpired, 1);
      assert.isTrue(
        yield* store
          .getChallenge(challengeHash)
          .pipe(Effect.map((value) => value._tag === "None"))
      );
    })
  );
});
