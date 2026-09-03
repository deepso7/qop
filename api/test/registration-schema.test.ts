import { assert, describe, it } from "@effect/vitest";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

import {
  registrationAdmissionCodes,
  registrationIntents,
  registrationRelayerState,
} from "../src/db/schema.ts";

const names = (values: readonly { readonly name?: string }[]) =>
  values.map((value) => value.name);
const dialect = new PgDialect();

describe("registration database schema", () => {
  it("contains only registration workflow tables", () => {
    assert.strictEqual(
      getTableConfig(registrationIntents).name,
      "registration_intents"
    );
    assert.strictEqual(
      getTableConfig(registrationAdmissionCodes).name,
      "registration_admission_codes"
    );
    assert.strictEqual(
      getTableConfig(registrationRelayerState).name,
      "registration_relayer_state"
    );
  });

  it("pins the registration intent columns, indexes, and checks", () => {
    const config = getTableConfig(registrationIntents);

    assert.deepStrictEqual(
      config.columns.map((column) => column.name),
      [
        "admission_code_hash",
        "confirmed_at",
        "created_at",
        "deadline",
        "device_key",
        "digest",
        "failure_code",
        "handle",
        "owner",
        "owner_signature",
        "qid",
        "registration_nonce",
        "registration_signature",
        "serialized_transaction",
        "status",
        "submitted_at",
        "transaction_hash",
        "updated_at",
      ]
    );
    assert.deepStrictEqual(
      config.primaryKeys.map((key) => key.getName()),
      ["registration_intents_pk"]
    );
    assert.deepStrictEqual(
      config.indexes.map((index) => index.config.name),
      [
        "registration_intents_nonce_unique",
        "registration_intents_active_handle_unique",
        "registration_intents_active_owner_unique",
        "registration_intents_status_deadline_idx",
      ]
    );
    assert.deepStrictEqual(
      config.indexes.map((index) => index.config.unique),
      [true, true, true, false]
    );
    assert.strictEqual(
      config.columns
        .find((column) => column.name === "device_key")
        ?.getSQLType(),
      "char(66)"
    );
    assert.deepStrictEqual(names(config.checks), [
      "registration_intents_status_check",
      "registration_intents_handle_check",
      "registration_intents_qid_check",
      "registration_intents_submission_check",
      "registration_intents_confirmation_check",
      "registration_intents_failure_check",
    ]);
    const [statusCheck] = config.checks;
    if (!statusCheck) {
      throw new Error("Missing registration status check");
    }
    assert.strictEqual(
      dialect.sqlToQuery(statusCheck.value).sql,
      `"registration_intents"."status" in ('ready', 'submitted', 'confirmed', 'failed')`
    );
    assert.deepStrictEqual(
      config.indexes.slice(1, 3).map((index) => {
        if (!index.config.where) {
          throw new Error(`Missing predicate for ${index.config.name}`);
        }
        return dialect.sqlToQuery(index.config.where).sql;
      }),
      [
        `"registration_intents"."status" <> 'failed'`,
        `"registration_intents"."status" <> 'failed'`,
      ]
    );
  });
});
