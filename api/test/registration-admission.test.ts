import { assert, layer } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";
import type { Hash } from "viem";

import {
  decodeRegistrationAdmissionCode,
  RegistrationAdmission,
  RegistrationAdmissionUnauthorized,
} from "../src/registration/admission.ts";
import { RegistrationAdmissionTestLive } from "./support/registration-database.ts";

const hash = (value: number): Hash =>
  `0x${value.toString(16).padStart(64, "0")}` as Hash;

layer(RegistrationAdmissionTestLive, { timeout: "30 seconds" })((it) => {
  it.effect("hashes normalized invitation codes identically", () =>
    Effect.gen(function* () {
      const canonical = yield* decodeRegistrationAdmissionCode("X1W-YT3");
      const compact = yield* decodeRegistrationAdmissionCode("x1wyt3");
      assert.strictEqual(compact.code, "X1W-YT3");
      assert.strictEqual(compact.codeHash, canonical.codeHash);
    })
  );

  it.effect("creates codes idempotently and validates them", () =>
    Effect.gen(function* () {
      const admissions = yield* RegistrationAdmission;
      const codeHash = hash(1);
      const now = yield* DateTime.now;
      const firstExpiry =
        BigInt(Math.floor(DateTime.toEpochMillis(now) / 1000)) + 5n;
      yield* admissions.create(codeHash, firstExpiry);
      yield* admissions.create(codeHash, firstExpiry + 100n);
      yield* admissions.validate(codeHash);
      yield* TestClock.adjust("5 seconds");
      assert.instanceOf(
        yield* admissions.validate(codeHash).pipe(Effect.flip),
        RegistrationAdmissionUnauthorized
      );
    })
  );

  it.effect("rejects codes at and after their expiry", () =>
    Effect.gen(function* () {
      const admissions = yield* RegistrationAdmission;
      const codeHash = hash(2);
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
    })
  );
});
