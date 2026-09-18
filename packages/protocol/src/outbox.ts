import { Handle } from "@qop/identity";
import { Schema } from "effect";

import { ChatFrameV1 } from "./chat-wire.ts";

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

const TimestampMillis = Schema.Int.check(
  Schema.makeFilter((value) => value >= 0 && value <= 8_640_000_000_000_000, {
    expected: "a valid nonnegative millisecond timestamp",
  })
);

/** Canonical decimal qid string (positive, no leading zeros). */
const OutboxQid = Schema.String.check(
  Schema.isMaxLength(78, { expected: "at most 78 decimal digits" }),
  Schema.isPattern(/^[1-9][0-9]*$/u, {
    expected: "a positive canonical qid decimal string",
  })
);

const ErrorNote = Schema.String.check(Schema.isLengthBetween(1, 400));

export const OutboxStatusV1 = Schema.Literals(["queued", "sent", "failed"]);
export type OutboxStatus = typeof OutboxStatusV1.Type;

export const OutboxRecordV1Schema = Schema.Struct({
  attempts: Schema.Int.check(
    Schema.makeFilter((value) => value >= 0 && value <= 1_000_000, {
      expected: "a nonnegative attempt count",
    })
  ),
  frame: ChatFrameV1,
  lastError: Schema.NullOr(ErrorNote),
  nextAttemptAt: TimestampMillis,
  queuedAt: TimestampMillis,
  status: OutboxStatusV1,
  toHandle: Handle,
  toQid: OutboxQid,
  updatedAt: TimestampMillis,
  v: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected outbox record field",
  parseOptions: strictParseOptions,
});
export { OutboxRecordV1Schema as OutboxRecordV1 };
export type OutboxRecordV1 = typeof OutboxRecordV1Schema.Type;

export const InboxRecordV1Schema = Schema.Struct({
  frame: ChatFrameV1,
  fromQid: OutboxQid,
  receivedAt: TimestampMillis,
  v: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected inbox record field",
  parseOptions: strictParseOptions,
});
export { InboxRecordV1Schema as InboxRecordV1 };
export type InboxRecordV1 = typeof InboxRecordV1Schema.Type;

/** Same logical id must keep the same content; a mismatch is a conflict. */
export const outboxRecordsConflict = (
  existing: OutboxRecordV1,
  candidate: OutboxRecordV1
) =>
  existing.frame.id === candidate.frame.id &&
  (existing.toHandle !== candidate.toHandle ||
    existing.toQid !== candidate.toQid ||
    existing.frame.fromHandle !== candidate.frame.fromHandle ||
    existing.frame.sentAt !== candidate.frame.sentAt ||
    existing.frame.text !== candidate.frame.text);

/** Same sender + id must keep the same content; a different sender is a new message. */
export const inboxRecordsConflict = (
  existing: InboxRecordV1,
  candidate: InboxRecordV1
) =>
  existing.frame.id === candidate.frame.id &&
  existing.fromQid === candidate.fromQid &&
  (existing.frame.fromHandle !== candidate.frame.fromHandle ||
    existing.frame.sentAt !== candidate.frame.sentAt ||
    existing.frame.text !== candidate.frame.text);
