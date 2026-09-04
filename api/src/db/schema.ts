import { sql } from "drizzle-orm";
import {
  char,
  check,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
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
const address = (name: string) => char(name, { length: 42 }).$type<Address>();
const hash32 = (name: string) => char(name, { length: 66 }).$type<Hash>();
const signature = (name: string) => char(name, { length: 132 }).$type<Hex>();

export const registrationIntents = pgTable(
  "registration_intents",
  {
    admissionCodeHash: hash32("admission_code_hash").notNull(),
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
    deviceKey: hash32("device_key").notNull(),
    digest: hash32("digest").notNull(),
    failureCode: varchar("failure_code", { length: 64 }),
    handle: varchar("handle", { length: 32 }).notNull(),
    owner: address("owner").notNull(),
    ownerSignature: signature("owner_signature").notNull(),
    qid: uint256("qid"),
    registrationNonce: hash32("registration_nonce").notNull(),
    registrationSignature: signature("registration_signature").notNull(),
    serializedTransaction: text("serialized_transaction").$type<Hex>(),
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
    uniqueIndex("registration_intents_active_handle_unique")
      .on(table.handle)
      .where(sql`${table.status} in ('ready', 'submitted')`),
    uniqueIndex("registration_intents_active_owner_unique")
      .on(table.owner)
      .where(sql`${table.status} in ('ready', 'submitted')`),
    index("registration_intents_status_deadline_idx").on(
      table.status,
      table.deadline
    ),
    check(
      "registration_intents_status_check",
      sql`${table.status} in ('ready', 'submitted', 'confirmed', 'failed')`
    ),
    check(
      "registration_intents_handle_check",
      sql`${table.handle} ~ '^[a-z0-9][a-z0-9_]{0,31}$'`
    ),
    check(
      "registration_intents_qid_check",
      sql`(${table.status} = 'confirmed' and ${table.qid} > 0) or (${table.status} <> 'confirmed' and ${table.qid} is null)`
    ),
    check(
      "registration_intents_submission_check",
      sql`${table.status} <> 'submitted' or (${table.submittedAt} is not null and ${table.transactionHash} is not null and ${table.serializedTransaction} is not null)`
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

export const registrationRelayerState = pgTable(
  "registration_relayer_state",
  {
    id: integer("id").primaryKey(),
    nextNonce: uint64("next_nonce").notNull(),
  },
  (table) => [
    check("registration_relayer_state_singleton_check", sql`${table.id} = 1`),
  ]
);

export const registrationAdmissionCodes = pgTable(
  "registration_admission_codes",
  {
    claimedAt: timestamp("claimed_at", { mode: "date", withTimezone: true }),
    claimedByDigest: hash32("claimed_by_digest"),
    codeHash: hash32("code_hash").notNull(),
    consumedAt: timestamp("consumed_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: uint64("expires_at"),
  },
  (table) => [
    primaryKey({
      columns: [table.codeHash],
      name: "registration_admission_codes_pk",
    }),
    index("registration_admission_codes_expiry_idx").on(table.expiresAt),
    check(
      "registration_admission_codes_claim_check",
      sql`(${table.claimedAt} is null) = (${table.claimedByDigest} is null)`
    ),
    check(
      "registration_admission_codes_consumed_check",
      sql`${table.consumedAt} is null or ${table.claimedByDigest} is not null`
    ),
  ]
);
