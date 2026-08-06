import { sql } from "drizzle-orm";
import {
  char,
  check,
  index,
  numeric,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

import type { RegistrationIntentStatus } from "../registration/types.ts";

const uint256 = (name: string) =>
  numeric(name, { mode: "bigint", precision: 78, scale: 0 });

const uint64 = (name: string) =>
  numeric(name, { mode: "bigint", precision: 20, scale: 0 });

const address = (name: string) => char(name, { length: 42 });
const hash32 = (name: string) => char(name, { length: 66 });
const signature = (name: string) => char(name, { length: 132 });

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

export const apiSchemaVersion = 1 as const;
