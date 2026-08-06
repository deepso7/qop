import { assert, layer } from "@effect/vitest";
import {
  Base64Url32,
  decodeDeviceCertificateV1,
  decodeIdentityEip712DomainV1,
  decodeIdentityEnvelopeV1,
  EcdsaSignature,
  encodeDeviceCertificateV1,
  hashDeviceCertificateV1,
  makeDeviceCertificateTypedDataV1,
  normalizeEcdsaSignature,
  PeerId,
} from "@qop/identity";
import { Effect, Layer, Schema } from "effect";
import { keccak256 } from "viem";
import type { Address, Hash, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  DeviceCertificateRejected,
  DeviceObservation,
  DeviceObservationRegistrationNotConfirmed,
  DeviceObservationUnauthorized,
} from "../src/device/observation.ts";
import { DeviceObservationCapabilityConflict } from "../src/device/store.ts";
import { Env } from "../src/env.ts";
import { RegistrationStore } from "../src/registration/store.ts";
import { RegistryReader } from "../src/registry/reader.ts";
import type {
  RegistryInvalidations,
  RegistryRead,
  RegistryReads,
} from "../src/registry/reader.ts";
import { DeviceAndRegistrationStoresTestLive } from "./support/registration-database.ts";

const OWNER_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
const REGISTRY_ADDRESS =
  "0x1111111111111111111111111111111111111111" as Address;
const PEER_ID = "12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X";
const SECOND_PEER_ID = Effect.runSync(
  Schema.encodeEffect(PeerId)(
    Uint8Array.from([0, 36, 8, 1, 18, 32, ...new Uint8Array(32).fill(2)])
  )
);
const account = privateKeyToAccount(OWNER_PRIVATE_KEY);
const owner = account.address.toLowerCase() as Address;
const AUTHORIZATION_SIGNATURE =
  `0x${"1".padStart(64, "0")}${"1".padStart(64, "0")}00` as Hex;

const read = <Value>(value: Value): RegistryRead<Value> => ({
  blockNumber: 100n,
  cachedAt: 0,
  freshness: "fresh",
  value,
});

let registryOwnerVersion = 0;
let registryRegisteredAt = 0n;
let revokedDigest: Hash | undefined;

const registryReads: RegistryReads = {
  account: (qid) =>
    Effect.succeed(
      read({
        handle: "alice",
        nonce: 0n,
        owner,
        ownerVersion: registryOwnerVersion,
        qid,
        registeredAt: registryRegisteredAt,
      })
    ),
  deviceRevocation: (_qid, digest) =>
    Effect.succeed(read(digest === revokedDigest)),
  qidByHandle: () => Effect.die("not used by device observation tests"),
  qidByOwner: () => Effect.die("not used by device observation tests"),
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
    cached: registryReads,
    fresh: {
      ...registryReads,
      registrationProbe: () =>
        Effect.die("not used by device observation tests"),
    },
    invalidate: registryInvalidations,
  })
);

const EnvTestLive = Layer.succeed(
  Env,
  Env.of({
    CHAIN_ID: 31_337n,
    DATABASE_URL: "postgresql://test",
    REGISTRY_ADDRESS,
    REGISTRY_CONFIRMATIONS: 0,
    RPC_URL: new URL("http://127.0.0.1:8545"),
  })
);

const DeviceObservationTestLive = DeviceObservation.layer.pipe(
  Layer.provideMerge(DeviceAndRegistrationStoresTestLive),
  Layer.provide(RegistryReaderTestLive),
  Layer.provide(EnvTestLive)
);

const domain = Effect.runSync(
  decodeIdentityEip712DomainV1({
    chainId: "31337",
    verifyingContract: REGISTRY_ADDRESS,
  })
);

const capability = (id: number) => {
  const bytes = new Uint8Array(32);
  bytes[31] = id;
  return {
    hash: keccak256(bytes),
    token: Effect.runSync(Schema.encodeEffect(Base64Url32)(bytes)),
  };
};

const hash = (value: number): Hash =>
  `0x${value.toString(16).padStart(64, "0")}` as Hash;

const confirmRegistration = Effect.fn("test.confirmRegistration")(function* (
  id: number,
  peerId: string,
  shouldConfirm = true
) {
  const registrations = yield* RegistrationStore;
  const observeCapability = capability(id);
  const digest = hash(1000 + id);
  yield* registrations.create({
    deadline: 600n,
    digest,
    handle: `device${String.fromCodePoint(96 + id)}`,
    observeTokenHash: observeCapability.hash,
    owner,
    peerId,
    registrationNonce: hash(2000 + id),
  });
  if (shouldConfirm) {
    yield* registrations.authorize(digest, {
      ownerSignature: AUTHORIZATION_SIGNATURE,
      registrationSignature: AUTHORIZATION_SIGNATURE,
    });
    yield* registrations.markConfirmed(digest, BigInt(40 + id));
  }
  return { digest, observeCapability, qid: BigInt(40 + id) };
});

const signedEnvelope = Effect.fn("test.signedEnvelope")(function* (
  qid: bigint,
  peerId: string,
  saltByte: number,
  options?: {
    readonly issuedAt?: bigint;
    readonly ownerVersion?: number;
  }
) {
  const key = new Uint8Array(32);
  const salt = new Uint8Array(32);
  salt.fill(saltByte);
  const certificate = yield* decodeDeviceCertificateV1({
    encryptionPublicKey: yield* Schema.encodeEffect(Base64Url32)(key),
    issuedAt: (options?.issuedAt ?? 0n).toString(),
    ownerVersion: options?.ownerVersion ?? 0,
    peerId,
    qid: qid.toString(),
    salt: yield* Schema.encodeEffect(Base64Url32)(salt),
    version: 1,
  });
  const walletSignature = yield* Effect.promise(() =>
    account.signTypedData(makeDeviceCertificateTypedDataV1(domain, certificate))
  );
  const signature = yield* normalizeEcdsaSignature(walletSignature);
  return {
    certificate: yield* encodeDeviceCertificateV1(certificate),
    signature: yield* Schema.encodeEffect(EcdsaSignature)(signature),
    version: 1 as const,
  };
});

layer(DeviceObservationTestLive, { timeout: "30 seconds" })((it) => {
  it.effect("observes a confirmed registration certificate idempotently", () =>
    Effect.gen(function* () {
      registryOwnerVersion = 0;
      registryRegisteredAt = 0n;
      revokedDigest = undefined;
      const registration = yield* confirmRegistration(1, PEER_ID);
      const envelope = yield* signedEnvelope(registration.qid, PEER_ID, 1);
      const observation = yield* DeviceObservation;

      const first = yield* observation.observeFromRegistration({
        envelope,
        observeToken: registration.observeCapability.token,
      });
      registryOwnerVersion = 1;
      revokedDigest = first.certificateDigest;
      const replay = yield* observation.observeFromRegistration({
        envelope,
        observeToken: registration.observeCapability.token,
      });

      assert.strictEqual(first.qid, registration.qid);
      assert.strictEqual(replay.certificateDigest, first.certificateDigest);
      assert.strictEqual(
        replay.observedAt.getTime(),
        first.observedAt.getTime()
      );

      registryOwnerVersion = 0;
      revokedDigest = undefined;

      const otherEnvelope = yield* signedEnvelope(registration.qid, PEER_ID, 2);
      assert.instanceOf(
        yield* observation
          .observeFromRegistration({
            envelope: otherEnvelope,
            observeToken: registration.observeCapability.token,
          })
          .pipe(Effect.flip),
        DeviceObservationCapabilityConflict
      );
    })
  );

  it.effect("rejects unknown, unconfirmed, and mismatched capabilities", () =>
    Effect.gen(function* () {
      registryOwnerVersion = 0;
      registryRegisteredAt = 0n;
      revokedDigest = undefined;
      const pending = yield* confirmRegistration(2, SECOND_PEER_ID, false);
      const envelope = yield* signedEnvelope(pending.qid, SECOND_PEER_ID, 3);
      const observation = yield* DeviceObservation;

      assert.instanceOf(
        yield* observation
          .observeFromRegistration({
            envelope,
            observeToken: capability(30).token,
          })
          .pipe(Effect.flip),
        DeviceObservationUnauthorized
      );
      assert.instanceOf(
        yield* observation
          .observeFromRegistration({
            envelope,
            observeToken: pending.observeCapability.token,
          })
          .pipe(Effect.flip),
        DeviceObservationRegistrationNotConfirmed
      );

      const confirmed = yield* confirmRegistration(3, PEER_ID);
      const wrongPeerEnvelope = yield* signedEnvelope(
        confirmed.qid,
        SECOND_PEER_ID,
        4
      );
      const rejected = yield* observation
        .observeFromRegistration({
          envelope: wrongPeerEnvelope,
          observeToken: confirmed.observeCapability.token,
        })
        .pipe(Effect.flip);
      assert.instanceOf(rejected, DeviceCertificateRejected);
      assert.strictEqual(rejected.reason, "peer-id");
    })
  );

  it.effect("rejects invalid owner signatures and revoked certificates", () =>
    Effect.gen(function* () {
      registryOwnerVersion = 0;
      registryRegisteredAt = 0n;
      revokedDigest = undefined;
      const invalidSignatureRegistration = yield* confirmRegistration(
        4,
        PEER_ID
      );
      const certificateEnvelope = yield* signedEnvelope(
        invalidSignatureRegistration.qid,
        PEER_ID,
        5
      );
      const signatureForOtherCertificate = yield* signedEnvelope(
        invalidSignatureRegistration.qid,
        PEER_ID,
        6
      );
      const observation = yield* DeviceObservation;
      const signatureError = yield* observation
        .observeFromRegistration({
          envelope: {
            ...certificateEnvelope,
            signature: signatureForOtherCertificate.signature,
          },
          observeToken: invalidSignatureRegistration.observeCapability.token,
        })
        .pipe(Effect.flip);
      assert.instanceOf(signatureError, DeviceCertificateRejected);
      assert.strictEqual(signatureError.reason, "owner-signature");

      const revokedRegistration = yield* confirmRegistration(5, PEER_ID);
      const revokedEnvelope = yield* signedEnvelope(
        revokedRegistration.qid,
        PEER_ID,
        7
      );
      const decoded = yield* decodeIdentityEnvelopeV1(revokedEnvelope);
      revokedDigest = yield* hashDeviceCertificateV1(
        domain,
        decoded.certificate
      );
      const revocationError = yield* observation
        .observeFromRegistration({
          envelope: revokedEnvelope,
          observeToken: revokedRegistration.observeCapability.token,
        })
        .pipe(Effect.flip);
      assert.instanceOf(revocationError, DeviceCertificateRejected);
      assert.strictEqual(revocationError.reason, "revoked");
      revokedDigest = undefined;
    })
  );

  it.effect("rejects qid, owner-version, and issued-at policy mismatches", () =>
    Effect.gen(function* () {
      registryOwnerVersion = 0;
      registryRegisteredAt = 100n;
      revokedDigest = undefined;
      const observation = yield* DeviceObservation;

      const qidRegistration = yield* confirmRegistration(6, PEER_ID);
      const wrongQid = yield* observation
        .observeFromRegistration({
          envelope: yield* signedEnvelope(999n, PEER_ID, 8),
          observeToken: qidRegistration.observeCapability.token,
        })
        .pipe(Effect.flip);
      assert.instanceOf(wrongQid, DeviceCertificateRejected);
      assert.strictEqual(wrongQid.reason, "qid");

      const versionRegistration = yield* confirmRegistration(7, PEER_ID);
      const wrongVersion = yield* observation
        .observeFromRegistration({
          envelope: yield* signedEnvelope(versionRegistration.qid, PEER_ID, 9, {
            issuedAt: 100n,
            ownerVersion: 1,
          }),
          observeToken: versionRegistration.observeCapability.token,
        })
        .pipe(Effect.flip);
      assert.instanceOf(wrongVersion, DeviceCertificateRejected);
      assert.strictEqual(wrongVersion.reason, "owner-version");

      const predatesRegistration = yield* confirmRegistration(8, PEER_ID);
      const predates = yield* observation
        .observeFromRegistration({
          envelope: yield* signedEnvelope(
            predatesRegistration.qid,
            PEER_ID,
            10,
            { issuedAt: 99n }
          ),
          observeToken: predatesRegistration.observeCapability.token,
        })
        .pipe(Effect.flip);
      assert.instanceOf(predates, DeviceCertificateRejected);
      assert.strictEqual(predates.reason, "predates-account");

      const futureRegistration = yield* confirmRegistration(9, PEER_ID);
      const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
      const future = yield* observation
        .observeFromRegistration({
          envelope: yield* signedEnvelope(futureRegistration.qid, PEER_ID, 11, {
            issuedAt: nowSeconds + 301n,
          }),
          observeToken: futureRegistration.observeCapability.token,
        })
        .pipe(Effect.flip);
      assert.instanceOf(future, DeviceCertificateRejected);
      assert.strictEqual(future.reason, "future-issued-at");

      registryRegisteredAt = 0n;
    })
  );
});
