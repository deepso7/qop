import { Base64Url32 } from "@qop/identity";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Context, Data, DateTime, Effect, Layer, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { concatBytes, keccak256, stringToBytes } from "viem";
import type { Hash } from "viem";

import { Database, DatabaseLive } from "../db/database.ts";
import { registrationAdmissionCodes } from "../db/schema.ts";

const admissionCodeHashDomain = stringToBytes("qop/registration-admission/v1");

export const decodeRegistrationAdmissionCode = Effect.fn(
  "RegistrationAdmission.decodeCode"
)(function* (input: unknown) {
  const code = yield* Schema.decodeUnknownEffect(Base64Url32)(input);
  return {
    code,
    codeHash: keccak256(concatBytes([admissionCodeHashDomain, code])) as Hash,
  };
});

export class RegistrationAdmissionUnauthorized extends Data.TaggedError(
  "RegistrationAdmissionUnauthorized"
)<{ readonly codeHash: Hash }> {}

export type RegistrationAdmissionError =
  | EffectDrizzleQueryError
  | RegistrationAdmissionUnauthorized
  | SqlError;

export interface RegistrationAdmissionShape {
  readonly consume: (
    codeHash: Hash,
    digest: Hash
  ) => Effect.Effect<void, RegistrationAdmissionError>;
  readonly create: (
    codeHash: Hash,
    expiresAt?: bigint
  ) => Effect.Effect<void, EffectDrizzleQueryError | SqlError>;
  readonly release: (
    codeHash: Hash,
    digest: Hash
  ) => Effect.Effect<void, EffectDrizzleQueryError | SqlError>;
  readonly reserve: (
    codeHash: Hash,
    digest: Hash
  ) => Effect.Effect<void, RegistrationAdmissionError>;
  readonly validate: (
    codeHash: Hash
  ) => Effect.Effect<void, RegistrationAdmissionError>;
}

const epochSeconds = (value: DateTime.DateTime): bigint =>
  BigInt(Math.floor(DateTime.toEpochMillis(value) / 1000));

export class RegistrationAdmission extends Context.Service<
  RegistrationAdmission,
  RegistrationAdmissionShape
>()("@qop/api/RegistrationAdmission") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const { client: db } = yield* Database;

      const validate = Effect.fn("RegistrationAdmission.validate")(function* (
        codeHash: Hash
      ) {
        const now = epochSeconds(yield* DateTime.now);
        const rows = yield* db
          .select({ codeHash: registrationAdmissionCodes.codeHash })
          .from(registrationAdmissionCodes)
          .where(
            and(
              eq(registrationAdmissionCodes.codeHash, codeHash),
              isNull(registrationAdmissionCodes.consumedAt),
              or(
                isNull(registrationAdmissionCodes.expiresAt),
                gt(registrationAdmissionCodes.expiresAt, now)
              )
            )
          )
          .limit(1);
        if (rows.length === 0) {
          return yield* new RegistrationAdmissionUnauthorized({ codeHash });
        }
      });

      const reserve = Effect.fn("RegistrationAdmission.reserve")(function* (
        codeHash: Hash,
        digest: Hash
      ) {
        const now = yield* DateTime.now;
        const nowSeconds = epochSeconds(now);
        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const rows = yield* tx
              .select()
              .from(registrationAdmissionCodes)
              .where(eq(registrationAdmissionCodes.codeHash, codeHash))
              .limit(1)
              .for("update");
            const code = rows.at(0);
            if (
              !code ||
              code.consumedAt !== null ||
              (code.expiresAt !== null && code.expiresAt <= nowSeconds) ||
              (code.claimedByDigest !== null && code.claimedByDigest !== digest)
            ) {
              return yield* new RegistrationAdmissionUnauthorized({ codeHash });
            }
            if (code.claimedByDigest === null) {
              yield* tx
                .update(registrationAdmissionCodes)
                .set({
                  claimedAt: DateTime.toDateUtc(now),
                  claimedByDigest: digest,
                })
                .where(eq(registrationAdmissionCodes.codeHash, codeHash));
            }
          })
        );
      });

      const consume = Effect.fn("RegistrationAdmission.consume")(function* (
        codeHash: Hash,
        digest: Hash
      ) {
        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const rows = yield* tx
              .select()
              .from(registrationAdmissionCodes)
              .where(eq(registrationAdmissionCodes.codeHash, codeHash))
              .limit(1)
              .for("update");
            const code = rows.at(0);
            if (!code || code.claimedByDigest !== digest) {
              return yield* new RegistrationAdmissionUnauthorized({ codeHash });
            }
            if (code.consumedAt === null) {
              yield* tx
                .update(registrationAdmissionCodes)
                .set({ consumedAt: DateTime.toDateUtc(yield* DateTime.now) })
                .where(eq(registrationAdmissionCodes.codeHash, codeHash));
            }
          })
        );
      });

      const release = Effect.fn("RegistrationAdmission.release")(function* (
        codeHash: Hash,
        digest: Hash
      ) {
        yield* db
          .update(registrationAdmissionCodes)
          .set({ claimedAt: null, claimedByDigest: null })
          .where(
            and(
              eq(registrationAdmissionCodes.codeHash, codeHash),
              eq(registrationAdmissionCodes.claimedByDigest, digest),
              isNull(registrationAdmissionCodes.consumedAt)
            )
          );
      });

      const create = Effect.fn("RegistrationAdmission.create")(function* (
        codeHash: Hash,
        expiresAt?: bigint
      ) {
        yield* db
          .insert(registrationAdmissionCodes)
          .values({ codeHash, expiresAt })
          .onConflictDoNothing();
      });

      return RegistrationAdmission.of({
        consume,
        create,
        release,
        reserve,
        validate,
      });
    })
  );
}

export const RegistrationAdmissionLive = RegistrationAdmission.layer.pipe(
  Layer.provide(DatabaseLive)
);
