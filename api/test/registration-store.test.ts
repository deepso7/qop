import { assert, layer } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { DateTime, Deferred, Effect, Fiber, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import type { Address } from "viem";

import { Database } from "../src/db/database.ts";
import { registrationAdmissionCodes } from "../src/db/schema.ts";
import {
  RegistrationAdmission,
  RegistrationAdmissionUnauthorized,
} from "../src/registration/admission.ts";
import {
  RegistrationActiveHandleConflict,
  RegistrationStore,
} from "../src/registration/store.ts";
import type { CreateRegistrationIntent } from "../src/registration/types.ts";
import {
  testAddress,
  testHash,
  testSignature,
  uppercaseHash,
} from "./support/ethereum.ts";
import {
  RegistrationStoreAndAdmissionTestLive,
  TestDatabaseLive,
} from "./support/registration-database.ts";

const signature = testSignature("1B");
const owner = (id: number): Address =>
  testAddress(`0x${id.toString(16).padStart(40, "0")}`);

const deadlineAfter = Effect.fn("test.deadlineAfter")(function* (
  seconds: number
) {
  const now = yield* DateTime.now;
  return BigInt(Math.floor(DateTime.toEpochMillis(now) / 1000) + seconds);
});

const input = (
  id: number,
  handle: string,
  deadline: bigint,
  inputOwner: Address = owner(id)
): CreateRegistrationIntent => ({
  admissionCodeHash: testHash(50_000 + id),
  deadline,
  deviceKey: testHash(40_000 + id),
  digest: testHash(10_000 + id),
  handle,
  owner: inputOwner,
  ownerSignature: signature,
  registrationNonce: testHash(30_000 + id),
  registrationSignature: signature,
});

const RegistrationStoreLockTestLive = Layer.merge(
  RegistrationAdmission.layer,
  RegistrationStore.layer
).pipe(Layer.provideMerge(TestDatabaseLive));

layer(RegistrationStoreAndAdmissionTestLive, { timeout: "30 seconds" })(
  (it) => {
    it.effect("creates a fully authorized ready row and claims its code", () =>
      Effect.gen(function* () {
        const store = yield* RegistrationStore;
        const admissions = yield* RegistrationAdmission;
        const registration = input(1, "alice", yield* deadlineAfter(60));
        const created = yield* store.create({
          ...registration,
          deviceKey: uppercaseHash(registration.deviceKey),
          digest: uppercaseHash(registration.digest),
          registrationNonce: uppercaseHash(registration.registrationNonce),
        });

        assert.strictEqual(created.status, "ready");
        assert.strictEqual(created.digest, registration.digest);
        assert.strictEqual(created.deviceKey, registration.deviceKey);
        assert.strictEqual(created.ownerSignature, testSignature("00"));
        const claimed = yield* admissions
          .validate(registration.admissionCodeHash)
          .pipe(Effect.flip);
        assert.strictEqual(claimed._tag, "RegistrationAdmissionUnauthorized");
        assert.strictEqual(
          Option.getOrThrow(yield* store.get(registration.digest)).digest,
          registration.digest
        );
      })
    );

    it.effect("maps the active-handle unique index to a handle conflict", () =>
      Effect.gen(function* () {
        const store = yield* RegistrationStore;
        const deadline = yield* deadlineAfter(60);
        yield* store.create(input(2, "shared", deadline));

        const conflict = yield* store
          .create(input(3, "shared", deadline))
          .pipe(Effect.flip);
        assert.instanceOf(conflict, RegistrationActiveHandleConflict);
        assert.strictEqual(conflict.handle, "shared");
      })
    );

    it.effect("releases handle and owner uniqueness after failure", () =>
      Effect.gen(function* () {
        const store = yield* RegistrationStore;
        const admissions = yield* RegistrationAdmission;
        const deadline = yield* deadlineAfter(60);
        const first = input(4, "retry", deadline);
        const created = yield* store.create(first);
        yield* store.markFailed(created.digest, "TEST_FAILURE");
        yield* admissions.validate(first.admissionCodeHash);

        const replacement = {
          ...input(5, "retry", deadline, first.owner),
          admissionCodeHash: first.admissionCodeHash,
        };
        assert.strictEqual((yield* store.create(replacement)).status, "ready");
      })
    );

    it.effect(
      "allocates relayer nonces and consumes the code on confirmation",
      () =>
        Effect.gen(function* () {
          const store = yield* RegistrationStore;
          const admissions = yield* RegistrationAdmission;
          const registration = input(6, "relay", yield* deadlineAfter(60));
          yield* store.create(registration);
          const allocated: bigint[] = [];
          const submitted = yield* store.prepareSubmission(
            registration.digest,
            Effect.succeed(5n),
            (nonce) =>
              Effect.sync(() => {
                allocated.push(nonce);
                return {
                  serializedTransaction: "0x02aa" as const,
                  transactionHash: testHash("transaction"),
                };
              })
          );
          const confirmed = yield* store.markConfirmed(
            registration.digest,
            42n
          );

          assert.deepStrictEqual(allocated, [5n]);
          assert.strictEqual(submitted.status, "submitted");
          assert.strictEqual(confirmed.status, "confirmed");
          assert.strictEqual(confirmed.qid, 42n);
          const denied = yield* admissions
            .validate(registration.admissionCodeHash)
            .pipe(Effect.flip);
          assert.strictEqual(denied._tag, "RegistrationAdmissionUnauthorized");
        })
    );
  }
);

layer(RegistrationStoreLockTestLive, { timeout: "30 seconds" })((it) => {
  it.effect("checks admission expiry after acquiring its row lock", () =>
    Effect.gen(function* () {
      const admissions = yield* RegistrationAdmission;
      const store = yield* RegistrationStore;
      const { client: db } = yield* Database;
      const registration = input(7, "lockwait", yield* deadlineAfter(60));
      const now = yield* DateTime.now;
      yield* admissions.create(
        registration.admissionCodeHash,
        BigInt(Math.floor(DateTime.toEpochMillis(now) / 1000)) + 1n
      );

      const locked = yield* Deferred.make<boolean>();
      const releaseLock = yield* Deferred.make<boolean>();
      const lockFiber = yield* Effect.forkChild(
        db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .select()
              .from(registrationAdmissionCodes)
              .where(
                eq(
                  registrationAdmissionCodes.codeHash,
                  registration.admissionCodeHash
                )
              )
              .for("update");
            yield* Deferred.succeed(locked, true);
            yield* Deferred.await(releaseLock);
          })
        )
      );
      yield* Deferred.await(locked);

      const createFiber = yield* Effect.forkChild(store.create(registration));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
      yield* Deferred.succeed(releaseLock, true);
      yield* Fiber.join(lockFiber);

      assert.instanceOf(
        yield* Fiber.join(createFiber).pipe(Effect.flip),
        RegistrationAdmissionUnauthorized
      );
    })
  );
});
