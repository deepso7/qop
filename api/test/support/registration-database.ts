import * as PgliteClient from "@effect/sql-pglite/PgliteClient";
import type { PGlite } from "@electric-sql/pglite";
import { pushSchema } from "drizzle-kit/api-postgres";
import * as PgliteDrizzle from "drizzle-orm/effect-pglite";
import { drizzle } from "drizzle-orm/pglite";
import { Effect, Layer } from "effect";

import { Database } from "../../src/db/database.ts";
import type { DatabaseClient } from "../../src/db/database.ts";
import * as databaseSchema from "../../src/db/schema.ts";
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

export const RegistrationStoreTestLive = RegistrationStore.layer.pipe(
  Layer.provide(TestDatabaseLive)
);
