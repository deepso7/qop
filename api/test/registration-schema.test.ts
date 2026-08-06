import { assert, describe, it } from "@effect/vitest";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

import {
  registrationHandleLeases,
  registrationIntents,
} from "../src/db/schema.ts";

const names = (values: readonly { readonly name?: string }[]) =>
  values.map((value) => value.name);

const dialect = new PgDialect();

describe("registration database schema", () => {
  it("pins registration intent constraints and indexes", () => {
    const config = getTableConfig(registrationIntents);

    assert.strictEqual(config.name, "registration_intents");
    assert.deepStrictEqual(
      config.primaryKeys.map((key) => key.getName()),
      ["registration_intents_pk"]
    );
    assert.deepStrictEqual(
      config.indexes.map((index) => index.config.name),
      [
        "registration_intents_nonce_unique",
        "registration_intents_observe_token_unique",
        "registration_intents_owner_idx",
        "registration_intents_status_deadline_idx",
      ]
    );
    assert.deepStrictEqual(
      config.indexes.map((index) => index.config.unique),
      [true, true, false, false]
    );
    assert.deepStrictEqual(names(config.checks), [
      "registration_intents_status_check",
      "registration_intents_handle_check",
      "registration_intents_qid_check",
      "registration_intents_authorization_check",
      "registration_intents_submission_check",
      "registration_intents_confirmation_check",
      "registration_intents_failure_check",
    ]);
    assert.deepStrictEqual(
      Object.fromEntries(
        config.checks.map((constraint) => {
          const query = dialect.sqlToQuery(constraint.value);
          assert.deepStrictEqual(query.params, []);
          return [constraint.name, query.sql];
        })
      ),
      {
        registration_intents_authorization_check:
          '"registration_intents"."status" not in (\'ready\', \'submitted\', \'confirmed\') or ("registration_intents"."owner_signature" is not null and "registration_intents"."registration_signature" is not null)',
        registration_intents_confirmation_check:
          '"registration_intents"."status" <> \'confirmed\' or "registration_intents"."confirmed_at" is not null',
        registration_intents_failure_check:
          '"registration_intents"."status" <> \'failed\' or "registration_intents"."failure_code" is not null',
        registration_intents_handle_check:
          '"registration_intents"."handle" ~ \'^[a-z]{1,32}$\'',
        registration_intents_qid_check:
          '("registration_intents"."status" = \'confirmed\' and "registration_intents"."qid" > 0) or ("registration_intents"."status" <> \'confirmed\' and "registration_intents"."qid" is null)',
        registration_intents_status_check:
          "\"registration_intents\".\"status\" in ('pending_owner_signature', 'ready', 'submitted', 'confirmed', 'failed', 'expired')",
        registration_intents_submission_check:
          '"registration_intents"."status" <> \'submitted\' or ("registration_intents"."submitted_at" is not null and "registration_intents"."transaction_hash" is not null)',
      }
    );
  });

  it("pins the one-live-lease shape and intent ownership", () => {
    const config = getTableConfig(registrationHandleLeases);

    assert.strictEqual(config.name, "registration_handle_leases");
    assert.deepStrictEqual(
      config.primaryKeys.map((key) => key.getName()),
      ["registration_handle_leases_pk"]
    );
    assert.deepStrictEqual(
      config.indexes.map((index) => index.config.name),
      ["registration_handle_leases_intent_unique"]
    );
    assert.deepStrictEqual(
      config.indexes.map((index) => index.config.unique),
      [true]
    );
    assert.strictEqual(config.foreignKeys.length, 1);
    const reference = config.foreignKeys[0]?.reference();
    assert.strictEqual(reference?.foreignTable, registrationIntents);
    assert.strictEqual(reference?.columns[0]?.name, "intent_digest");
    assert.strictEqual(reference?.foreignColumns[0]?.name, "digest");
  });
});
