import type { IdentityEnvelopeV1Encoded } from "@qop/identity";
import { eq } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Context, Data, DateTime, Effect, Layer, Option } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Hash, Hex } from "viem";

import { Database, DatabaseLive } from "../db/database.ts";
import type { DatabaseClient } from "../db/database.ts";
import {
  deviceCertificates,
  registrationDeviceObservations,
} from "../db/schema.ts";
import { normalizeRegistrationDigest } from "../registration/inputs.ts";
import type { RegistrationInputError } from "../registration/inputs.ts";
import { normalizeCertificateDigest } from "../registry/inputs.ts";
import type { RegistryInputError } from "../registry/inputs.ts";
import { normalizeIdentityEnvelope } from "./inputs.ts";
import type { DeviceCertificateInputError } from "./inputs.ts";

export type StoredDeviceCertificate = InferSelectModel<
  typeof deviceCertificates
>;

type TransactionCallback = Parameters<DatabaseClient["transaction"]>[0];
type Transaction = Parameters<TransactionCallback>[0];

export interface ObserveRegistrationDeviceCertificate {
  readonly certificateDigest: Hash;
  readonly envelope: IdentityEnvelopeV1Encoded;
  readonly registrationIntentDigest: Hash;
}

export class DeviceObservationCapabilityConflict extends Data.TaggedError(
  "DeviceObservationCapabilityConflict"
)<{
  readonly certificateDigest: Hash;
  readonly registrationIntentDigest: Hash;
}> {}

export type DeviceCertificateStorePersistenceError =
  | EffectDrizzleQueryError
  | SqlError;

export type DeviceCertificateStoreError =
  | DeviceCertificateInputError
  | DeviceCertificateStorePersistenceError
  | DeviceObservationCapabilityConflict
  | RegistrationInputError
  | RegistryInputError;

export interface DeviceCertificateStoreShape {
  readonly get: (
    certificateDigest: Hash
  ) => Effect.Effect<
    Option.Option<StoredDeviceCertificate>,
    DeviceCertificateStoreError
  >;
  readonly getObservedFromRegistration: (
    registrationIntentDigest: Hash
  ) => Effect.Effect<
    Option.Option<StoredDeviceCertificate>,
    DeviceCertificateStoreError
  >;
  readonly observeFromRegistration: (
    input: ObserveRegistrationDeviceCertificate
  ) => Effect.Effect<StoredDeviceCertificate, DeviceCertificateStoreError>;
}

const findCertificate = (
  client: DatabaseClient | Transaction,
  certificateDigest: Hash
) =>
  client
    .select()
    .from(deviceCertificates)
    .where(eq(deviceCertificates.certificateDigest, certificateDigest))
    .limit(1)
    .pipe(Effect.map((rows) => rows.at(0)));

const findRegistrationObservation = (
  client: DatabaseClient | Transaction,
  registrationIntentDigest: Hash
) =>
  client
    .select()
    .from(registrationDeviceObservations)
    .where(
      eq(
        registrationDeviceObservations.registrationIntentDigest,
        registrationIntentDigest
      )
    )
    .limit(1)
    .pipe(Effect.map((rows) => rows.at(0)));

export class DeviceCertificateStore extends Context.Service<
  DeviceCertificateStore,
  DeviceCertificateStoreShape
>()("@qop/api/DeviceCertificateStore") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const { client: db } = yield* Database;

      const get = Effect.fn("DeviceCertificateStore.get")(function* (
        certificateDigest: Hash
      ) {
        const digest = yield* normalizeCertificateDigest(certificateDigest);
        return Option.fromUndefinedOr(yield* findCertificate(db, digest));
      });

      const getObservedFromRegistration = Effect.fn(
        "DeviceCertificateStore.getObservedFromRegistration"
      )(function* (registrationIntentDigest: Hash) {
        const digest = yield* normalizeRegistrationDigest(
          registrationIntentDigest
        );
        const observation = yield* findRegistrationObservation(db, digest);
        if (!observation) {
          return Option.none<StoredDeviceCertificate>();
        }
        return Option.fromUndefinedOr(
          yield* findCertificate(db, observation.certificateDigest)
        );
      });

      const observeFromRegistration = Effect.fn(
        "DeviceCertificateStore.observeFromRegistration"
      )(function* (input: ObserveRegistrationDeviceCertificate) {
        const certificateDigest = yield* normalizeCertificateDigest(
          input.certificateDigest
        );
        const registrationIntentDigest = yield* normalizeRegistrationDigest(
          input.registrationIntentDigest
        );
        const envelope = yield* normalizeIdentityEnvelope(input.envelope);
        const now = yield* DateTime.now;
        const observedAt = DateTime.toDateUtc(now);

        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const priorObservation = yield* findRegistrationObservation(
              tx,
              registrationIntentDigest
            );
            if (priorObservation) {
              if (priorObservation.certificateDigest !== certificateDigest) {
                return yield* new DeviceObservationCapabilityConflict({
                  certificateDigest: priorObservation.certificateDigest,
                  registrationIntentDigest,
                });
              }
              const existing = yield* findCertificate(tx, certificateDigest);
              if (existing) {
                return existing;
              }
            }

            const certificate: typeof deviceCertificates.$inferInsert = {
              certificateDigest,
              encryptionPublicKey: envelope.certificate.encryptionPublicKey,
              expiresAt: BigInt(envelope.certificate.expiresAt),
              issuedAt: BigInt(envelope.certificate.issuedAt),
              observedAt,
              ownerVersion: envelope.certificate.ownerVersion,
              peerId: envelope.certificate.peerId,
              qid: BigInt(envelope.certificate.qid),
              salt: envelope.certificate.salt,
              signature: envelope.signature as Hex,
              version: envelope.version,
            };
            yield* tx
              .insert(deviceCertificates)
              .values(certificate)
              .onConflictDoNothing();

            const insertedObservation = yield* tx
              .insert(registrationDeviceObservations)
              .values({
                certificateDigest,
                observedAt,
                registrationIntentDigest,
              })
              .onConflictDoNothing()
              .returning();

            if (insertedObservation.length === 0) {
              const concurrentObservation = yield* findRegistrationObservation(
                tx,
                registrationIntentDigest
              );
              if (
                concurrentObservation?.certificateDigest !== certificateDigest
              ) {
                return yield* new DeviceObservationCapabilityConflict({
                  certificateDigest:
                    concurrentObservation?.certificateDigest ??
                    certificateDigest,
                  registrationIntentDigest,
                });
              }
            }

            const stored = yield* findCertificate(tx, certificateDigest);
            if (!stored) {
              return yield* Effect.die(
                `Certificate ${certificateDigest} disappeared after observation`
              );
            }
            return stored;
          })
        );
      });

      return DeviceCertificateStore.of({
        get,
        getObservedFromRegistration,
        observeFromRegistration,
      });
    })
  );
}

export const DeviceCertificateStoreLive = DeviceCertificateStore.layer.pipe(
  Layer.provide(DatabaseLive)
);
