import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { Context, Effect, Layer, Redacted } from "effect";

import { Env } from "../env.ts";

const makeDatabaseClient = PgDrizzle.makeWithDefaults();

export type DatabaseClient = Effect.Success<typeof makeDatabaseClient>;

export class Database extends Context.Service<
  Database,
  {
    readonly client: DatabaseClient;
  }
>()("@qop/api/Database") {
  static readonly layer = Layer.effect(
    this,
    makeDatabaseClient.pipe(Effect.map((client) => this.of({ client })))
  );
}

const PgClientLive = Layer.unwrap(
  Effect.gen(function* () {
    const env = yield* Env;
    return PgClient.layer({
      applicationName: "qop-api",
      maxConnections: 10,
      url: Redacted.make(env.DATABASE_URL),
    });
  })
);

export const DatabaseLive = Database.layer.pipe(
  Layer.provide(PgClientLive),
  Layer.provide(Env.layer)
);
