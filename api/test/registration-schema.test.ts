import { assert, describe, it } from "@effect/vitest";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

import {
  deviceCertificates,
  deviceSessionChallenges,
  deviceSessions,
  registrationDeviceObservations,
  registrationHandleLeases,
  registrationIntents,
} from "../src/db/schema.ts";

const names = (values: readonly { readonly name?: string }[]) =>
  values.map((value) => value.name);

const dialect = new PgDialect();

describe("registration database schema", () => {
  it("pins short-lived device session constraints", () => {
    const config = getTableConfig(deviceSessions);
    assert.strictEqual(config.name, "device_sessions");
    assert.deepStrictEqual(
      config.primaryKeys.map((key) => key.getName()),
      ["device_sessions_pk"]
    );
    assert.deepStrictEqual(
      config.indexes.map((index) => index.config.name),
      ["device_sessions_certificate_expiry_idx", "device_sessions_expiry_idx"]
    );
    assert.deepStrictEqual(names(config.checks), [
      "device_sessions_qid_check",
      "device_sessions_owner_version_check",
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
        device_sessions_owner_version_check:
          '"device_sessions"."owner_version" between 0 and 4294967295',
        device_sessions_qid_check: '"device_sessions"."qid" > 0',
      }
    );
    assert.strictEqual(config.foreignKeys.length, 1);
    assert.strictEqual(
      config.columns
        .find((column) => column.name === "owner_version")
        ?.getSQLType(),
      "numeric(10, 0)"
    );
  });

  it("pins single-use device session challenge constraints", () => {
    const config = getTableConfig(deviceSessionChallenges);
    assert.strictEqual(config.name, "device_session_challenges");
    assert.deepStrictEqual(
      config.primaryKeys.map((key) => key.getName()),
      ["device_session_challenges_pk"]
    );
    assert.deepStrictEqual(
      config.indexes.map((index) => index.config.name),
      [
        "device_session_challenges_certificate_expiry_idx",
        "device_session_challenges_expiry_idx",
        "device_session_challenges_open_certificate_flow_unique",
      ]
    );
    assert.deepStrictEqual(
      config.indexes.map((index) => index.config.unique),
      [false, false, true]
    );
    assert.deepStrictEqual(names(config.checks), [
      "device_session_challenges_qid_check",
      "device_session_challenges_time_check",
      "device_session_challenges_flow_check",
      "device_session_challenges_version_check",
    ]);
    assert.strictEqual(config.foreignKeys.length, 1);
    assert.deepStrictEqual(
      Object.fromEntries(
        config.checks.map((constraint) => [
          constraint.name,
          dialect.sqlToQuery(constraint.value).sql,
        ])
      ),
      {
        device_session_challenges_flow_check:
          "\"device_session_challenges\".\"flow\" in ('registration', 'pairing', 'restore')",
        device_session_challenges_qid_check:
          '"device_session_challenges"."qid" > 0',
        device_session_challenges_time_check:
          '"device_session_challenges"."expires_at" > "device_session_challenges"."issued_at"',
        device_session_challenges_version_check:
          '"device_session_challenges"."version" = 1',
      }
    );
  });

  it("pins device certificates and single-use registration observations", () => {
    const certificateConfig = getTableConfig(deviceCertificates);
    assert.strictEqual(certificateConfig.name, "device_certificates");
    assert.deepStrictEqual(
      certificateConfig.primaryKeys.map((key) => key.getName()),
      ["device_certificates_pk"]
    );
    assert.deepStrictEqual(
      certificateConfig.indexes.map((index) => index.config.name),
      ["device_certificates_qid_observed_idx"]
    );
    assert.strictEqual(
      certificateConfig.columns
        .find((column) => column.name === "owner_version")
        ?.getSQLType(),
      "numeric(10, 0)"
    );
    assert.deepStrictEqual(names(certificateConfig.checks), [
      "device_certificates_qid_check",
      "device_certificates_owner_version_check",
      "device_certificates_version_check",
    ]);
    assert.deepStrictEqual(
      Object.fromEntries(
        certificateConfig.checks.map((constraint) => {
          const query = dialect.sqlToQuery(constraint.value);
          assert.deepStrictEqual(query.params, []);
          return [constraint.name, query.sql];
        })
      ),
      {
        device_certificates_owner_version_check:
          '"device_certificates"."owner_version" between 0 and 4294967295',
        device_certificates_qid_check: '"device_certificates"."qid" > 0',
        device_certificates_version_check:
          '"device_certificates"."version" = 1',
      }
    );

    const observationConfig = getTableConfig(registrationDeviceObservations);
    assert.strictEqual(
      observationConfig.name,
      "registration_device_observations"
    );
    assert.deepStrictEqual(
      observationConfig.primaryKeys.map((key) => key.getName()),
      ["registration_device_observations_pk"]
    );
    assert.deepStrictEqual(
      observationConfig.indexes.map((index) => index.config.name),
      ["registration_device_observations_certificate_idx"]
    );
    assert.strictEqual(observationConfig.foreignKeys.length, 2);
  });

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
