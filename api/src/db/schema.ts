import { sql } from "drizzle-orm";
import {
  char,
  check,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import type { Address, Hash, Hex } from "viem";

import type { RegistrationIntentStatus } from "../registration/types.ts";

const uint256 = (name: string) =>
  numeric(name, { mode: "bigint", precision: 78, scale: 0 });

const uint64 = (name: string) =>
  numeric(name, { mode: "bigint", precision: 20, scale: 0 });

const uint32 = (name: string) =>
  numeric(name, { mode: "number", precision: 10, scale: 0 });

const address = (name: string) => char(name, { length: 42 }).$type<Address>();
const hash32 = (name: string) => char(name, { length: 66 }).$type<Hash>();
const signature = (name: string) => char(name, { length: 132 }).$type<Hex>();

export const registrationIntents = pgTable(
  "registration_intents",
  {
    confirmedAt: timestamp("confirmed_at", {
      mode: "date",
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    deadline: uint64("deadline").notNull(),
    digest: hash32("digest").notNull(),
    failureCode: varchar("failure_code", { length: 64 }),
    handle: varchar("handle", { length: 32 }).notNull(),
    observeTokenHash: hash32("observe_token_hash").notNull(),
    owner: address("owner").notNull(),
    ownerSignature: signature("owner_signature"),
    peerId: char("peer_id", { length: 52 }).notNull(),
    qid: uint256("qid"),
    registrationNonce: hash32("registration_nonce").notNull(),
    registrationSignature: signature("registration_signature"),
    status: varchar("status", { length: 32 })
      .$type<RegistrationIntentStatus>()
      .notNull(),
    submittedAt: timestamp("submitted_at", {
      mode: "date",
      withTimezone: true,
    }),
    transactionHash: hash32("transaction_hash"),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.digest],
      name: "registration_intents_pk",
    }),
    uniqueIndex("registration_intents_nonce_unique").on(
      table.registrationNonce
    ),
    uniqueIndex("registration_intents_observe_token_unique").on(
      table.observeTokenHash
    ),
    index("registration_intents_owner_idx").on(table.owner),
    index("registration_intents_status_deadline_idx").on(
      table.status,
      table.deadline
    ),
    check(
      "registration_intents_status_check",
      sql`${table.status} in ('pending_owner_signature', 'ready', 'submitted', 'confirmed', 'failed', 'expired')`
    ),
    check(
      "registration_intents_handle_check",
      sql`${table.handle} ~ '^[a-z]{1,32}$'`
    ),
    check(
      "registration_intents_qid_check",
      sql`(${table.status} = 'confirmed' and ${table.qid} > 0) or (${table.status} <> 'confirmed' and ${table.qid} is null)`
    ),
    check(
      "registration_intents_authorization_check",
      sql`${table.status} not in ('ready', 'submitted', 'confirmed') or (${table.ownerSignature} is not null and ${table.registrationSignature} is not null)`
    ),
    check(
      "registration_intents_submission_check",
      sql`${table.status} <> 'submitted' or (${table.submittedAt} is not null and ${table.transactionHash} is not null)`
    ),
    check(
      "registration_intents_confirmation_check",
      sql`${table.status} <> 'confirmed' or ${table.confirmedAt} is not null`
    ),
    check(
      "registration_intents_failure_check",
      sql`${table.status} <> 'failed' or ${table.failureCode} is not null`
    ),
  ]
);

export const deviceCertificates = pgTable(
  "device_certificates",
  {
    certificateDigest: hash32("certificate_digest").notNull(),
    encryptionPublicKey: char("encryption_public_key", {
      length: 43,
    }).notNull(),
    issuedAt: uint64("issued_at").notNull(),
    observedAt: timestamp("observed_at", {
      mode: "date",
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    ownerVersion: uint32("owner_version").notNull(),
    peerId: char("peer_id", { length: 52 }).notNull(),
    qid: uint256("qid").notNull(),
    salt: char("salt", { length: 43 }).notNull(),
    signature: signature("signature").notNull(),
    version: integer("version").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.certificateDigest],
      name: "device_certificates_pk",
    }),
    index("device_certificates_qid_observed_idx").on(
      table.qid,
      table.observedAt
    ),
    check("device_certificates_qid_check", sql`${table.qid} > 0`),
    check(
      "device_certificates_owner_version_check",
      sql`${table.ownerVersion} between 0 and 4294967295`
    ),
    check("device_certificates_version_check", sql`${table.version} = 1`),
  ]
);

export const registrationDeviceObservations = pgTable(
  "registration_device_observations",
  {
    certificateDigest: hash32("certificate_digest")
      .notNull()
      .references(() => deviceCertificates.certificateDigest, {
        onDelete: "restrict",
      }),
    observedAt: timestamp("observed_at", {
      mode: "date",
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    registrationIntentDigest: hash32("registration_intent_digest")
      .notNull()
      .references(() => registrationIntents.digest, { onDelete: "restrict" }),
  },
  (table) => [
    primaryKey({
      columns: [table.registrationIntentDigest],
      name: "registration_device_observations_pk",
    }),
    index("registration_device_observations_certificate_idx").on(
      table.certificateDigest
    ),
  ]
);

export const registrationHandleLeases = pgTable(
  "registration_handle_leases",
  {
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    handle: varchar("handle", { length: 32 }).notNull(),
    intentDigest: hash32("intent_digest")
      .notNull()
      .references(() => registrationIntents.digest, { onDelete: "cascade" }),
    owner: address("owner").notNull(),
    peerId: char("peer_id", { length: 52 }).notNull(),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.handle],
      name: "registration_handle_leases_pk",
    }),
    uniqueIndex("registration_handle_leases_intent_unique").on(
      table.intentDigest
    ),
  ]
);

export const apiSchemaVersion = 2 as const;
