import * as PgliteClient from "@effect/sql-pglite/PgliteClient";
import type { PGlite } from "@electric-sql/pglite";
import { pushSchema } from "drizzle-kit/api-postgres";
import * as PgliteDrizzle from "drizzle-orm/effect-pglite";
import { drizzle } from "drizzle-orm/pglite";
import { Effect, Layer } from "effect";

import { Database } from "../../src/db/database.ts";
import type { DatabaseClient } from "../../src/db/database.ts";
import * as databaseSchema from "../../src/db/schema.ts";
import { DeviceSessionStore } from "../../src/device-session/store.ts";
import { DeviceCertificateStore } from "../../src/device/store.ts";
import { RegistrationAdmission } from "../../src/registration/admission.ts";
import { RegistrationStore } from "../../src/registration/store.ts";

const PgliteLive = PgliteClient.layer();

export const TestDatabaseLive = Layer.effect(
  Database,
  Effect.gen(function* () {
    const pglite = yield* PgliteClient.PgliteClient;
    yield* Effect.tryPromise(async () => {
      const database = drizzle({ client: pglite.pglite as PGlite });
      const schema = await pushSchema(databaseSchema, database);
      await schema.apply();
    });
    const client = yield* PgliteDrizzle.makeWithDefaults();
    return Database.of({ client: client as unknown as DatabaseClient });
  })
).pipe(Layer.provide(PgliteLive));

export const RegistrationStoreTestLive = Layer.effect(
  RegistrationStore,
  Effect.gen(function* () {
    const admission = yield* RegistrationAdmission;
    const store = yield* RegistrationStore;
    return RegistrationStore.of({
      ...store,
      create: (input) =>
        admission
          .create(
            input.admissionCodeHash.toLowerCase() as typeof input.admissionCodeHash
          )
          .pipe(Effect.flatMap(() => store.create(input))),
    });
  })
).pipe(
  Layer.provide(
    Layer.merge(RegistrationAdmission.layer, RegistrationStore.layer).pipe(
      Layer.provide(TestDatabaseLive)
    )
  )
);

export const RegistrationAdmissionTestLive = RegistrationAdmission.layer.pipe(
  Layer.provide(TestDatabaseLive)
);

export const DeviceAndRegistrationStoresTestLive = Layer.mergeAll(
  DeviceCertificateStore.layer,
  RegistrationStoreTestLive,
  DeviceSessionStore.layer
).pipe(Layer.provide(TestDatabaseLive));
