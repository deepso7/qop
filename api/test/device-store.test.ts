import { assert, layer } from "@effect/vitest";
import { DateTime, Effect, Option, Result } from "effect";
import type { Address, Hash, Hex } from "viem";

import {
  DeviceCertificateStore,
  DeviceObservationCapabilityConflict,
} from "../src/device/store.ts";
import { RegistrationStore } from "../src/registration/store.ts";
import type { CreateRegistrationIntent } from "../src/registration/types.ts";
import { DeviceAndRegistrationStoresTestLive } from "./support/registration-database.ts";

const OWNER = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf" as Address;
const PEER_ID = "12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X";
const SIGNATURE = `0x${"1".padStart(64, "0")}${"1".padStart(64, "0")}00` as Hex;

const hash = (value: number): Hash =>
  `0x${value.toString(16).padStart(64, "0")}` as Hash;

const registrationInput = Effect.fn("test.registrationInput")(function* (
  id: number,
  handle: string
): Effect.fn.Return<CreateRegistrationIntent> {
  const now = yield* DateTime.now;
  return {
    deadline: BigInt(Math.floor(DateTime.toEpochMillis(now) / 1000) + 60),
    digest: hash(1000 + id),
    handle,
    observeTokenHash: hash(2000 + id),
    owner: OWNER,
    peerId: PEER_ID,
    registrationNonce: hash(3000 + id),
  };
});

const envelope = {
  certificate: {
    encryptionPublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    issuedAt: "1700000000",
    ownerVersion: 0,
    peerId: PEER_ID,
    qid: "42",
    salt: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
    version: 1,
  },
  signature: SIGNATURE,
  version: 1,
} as const;

layer(DeviceAndRegistrationStoresTestLive, { timeout: "30 seconds" })((it) => {
  it.effect(
    "observes once per registration capability and replays exactly",
    () =>
      Effect.gen(function* () {
        const certificates = yield* DeviceCertificateStore;
        const registrations = yield* RegistrationStore;
        const registration = yield* registrationInput(1, "deviceone");
        yield* registrations.create(registration);
        yield* registrations.authorize(registration.digest, {
          ownerSignature: SIGNATURE,
          registrationSignature: SIGNATURE,
        });
        yield* registrations.markConfirmed(registration.digest, 42n);

        const certificateDigest = hash(4001);
        const first = yield* certificates.observeFromRegistration({
          certificateDigest: certificateDigest.toUpperCase() as Hash,
          envelope,
          registrationIntentDigest: registration.digest,
        });
        const replay = yield* certificates.observeFromRegistration({
          certificateDigest,
          envelope,
          registrationIntentDigest: registration.digest,
        });

        assert.strictEqual(first.certificateDigest, certificateDigest);
        assert.strictEqual(first.peerId, PEER_ID);
        assert.strictEqual(first.qid, 42n);
        assert.strictEqual(
          replay.observedAt.getTime(),
          first.observedAt.getTime()
        );
        assert.strictEqual(
          Option.getOrThrow(yield* certificates.get(certificateDigest))
            .certificateDigest,
          certificateDigest
        );
        assert.strictEqual(
          Option.getOrThrow(
            yield* certificates.getObservedFromRegistration(registration.digest)
          ).certificateDigest,
          certificateDigest
        );

        const conflict = yield* certificates
          .observeFromRegistration({
            certificateDigest: hash(4002),
            envelope,
            registrationIntentDigest: registration.digest,
          })
          .pipe(Effect.flip);
        assert.instanceOf(conflict, DeviceObservationCapabilityConflict);
        assert.strictEqual(conflict.certificateDigest, certificateDigest);
      })
  );

  it.effect("allows only one winner when a capability races", () =>
    Effect.gen(function* () {
      const certificates = yield* DeviceCertificateStore;
      const registrations = yield* RegistrationStore;
      const registration = yield* registrationInput(2, "devicerace");
      yield* registrations.create(registration);
      yield* registrations.authorize(registration.digest, {
        ownerSignature: SIGNATURE,
        registrationSignature: SIGNATURE,
      });
      yield* registrations.markConfirmed(registration.digest, 42n);

      const results = yield* Effect.all(
        [hash(4101), hash(4102)].map((certificateDigest) =>
          certificates
            .observeFromRegistration({
              certificateDigest,
              envelope,
              registrationIntentDigest: registration.digest,
            })
            .pipe(Effect.result)
        ),
        { concurrency: "unbounded" }
      );
      const failures = results.filter(Result.isFailure);
      const successes = results.filter(Result.isSuccess);

      assert.lengthOf(successes, 1);
      assert.lengthOf(failures, 1);
      assert.instanceOf(
        failures[0]?.failure,
        DeviceObservationCapabilityConflict
      );
    })
  );
});
