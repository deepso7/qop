import { assert, layer } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";
import type { Hash } from "viem";

import {
  RegistrationAdmission,
  RegistrationAdmissionUnauthorized,
} from "../src/registration/admission.ts";
import { RegistrationAdmissionTestLive } from "./support/registration-database.ts";

const hash = (value: number): Hash =>
  `0x${value.toString(16).padStart(64, "0")}` as Hash;

layer(RegistrationAdmissionTestLive, { timeout: "30 seconds" })((it) => {
  it.effect(
    "claims once, supports exact replay, and consumes permanently",
    () =>
      Effect.gen(function* () {
        const admissions = yield* RegistrationAdmission;
        const codeHash = hash(1);
        const digest = hash(2);
        yield* admissions.create(codeHash);
        yield* admissions.validate(codeHash);
        yield* admissions.reserve(codeHash, digest);
        yield* admissions.reserve(codeHash, digest);

        assert.instanceOf(
          yield* admissions.reserve(codeHash, hash(3)).pipe(Effect.flip),
          RegistrationAdmissionUnauthorized
        );

        yield* admissions.consume(codeHash, digest);
        yield* admissions.consume(codeHash, digest);
        assert.instanceOf(
          yield* admissions.validate(codeHash).pipe(Effect.flip),
          RegistrationAdmissionUnauthorized
        );
      })
  );

  it.effect("releases an unconsumed claim", () =>
    Effect.gen(function* () {
      const admissions = yield* RegistrationAdmission;
      const codeHash = hash(4);
      yield* admissions.create(codeHash);
      yield* admissions.reserve(codeHash, hash(5));
      yield* admissions.release(codeHash, hash(5));
      yield* admissions.reserve(codeHash, hash(6));
    })
  );

  it.effect("rejects codes at and after their expiry", () =>
    Effect.gen(function* () {
      const admissions = yield* RegistrationAdmission;
      const codeHash = hash(7);
      const now = yield* DateTime.now;
      const expiresAt =
        BigInt(Math.floor(DateTime.toEpochMillis(now) / 1000)) + 5n;
      yield* admissions.create(codeHash, expiresAt);
      yield* admissions.validate(codeHash);
      yield* TestClock.adjust("5 seconds");

      assert.instanceOf(
        yield* admissions.validate(codeHash).pipe(Effect.flip),
        RegistrationAdmissionUnauthorized
      );
      assert.instanceOf(
        yield* admissions.reserve(codeHash, hash(8)).pipe(Effect.flip),
        RegistrationAdmissionUnauthorized
      );
    })
  );
});
