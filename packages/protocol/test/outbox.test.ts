import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  inboxRecordsConflict,
  OutboxRecordV1,
  outboxRecordsConflict,
} from "../src/outbox.ts";

const id = "c56a4180-65aa-42ec-a945-5fd21dec0538";

const queued = {
  attempts: 0,
  frame: {
    fromHandle: "alice",
    id,
    sentAt: 1_700_000_000_000,
    text: "hello",
    v: 1 as const,
  },
  lastError: null,
  nextAttemptAt: 1_700_000_000_000,
  queuedAt: 1_700_000_000_000,
  status: "queued" as const,
  toHandle: "bob",
  toQid: "1",
  updatedAt: 1_700_000_000_000,
  v: 1 as const,
};

describe("outbox records", () => {
  it("round-trips a queued record", async () => {
    const encoded = await Effect.runPromise(
      Schema.encodeEffect(OutboxRecordV1)(queued)
    );
    const decoded = await Effect.runPromise(
      Schema.decodeUnknownEffect(OutboxRecordV1)(encoded)
    );
    expect(decoded).toEqual(queued);
  });

  it("rejects an unknown status", async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknownEffect(OutboxRecordV1)({
        ...queued,
        status: "sending",
      }).pipe(Effect.result)
    );
    expect(result._tag).toBe("Failure");
  });

  it("rejects a leading-zero qid", async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknownEffect(OutboxRecordV1)({
        ...queued,
        toQid: "01",
      }).pipe(Effect.result)
    );
    expect(result._tag).toBe("Failure");
  });

  it("detects content conflicts under the same id", () => {
    expect(outboxRecordsConflict(queued, queued)).toBe(false);
    expect(
      outboxRecordsConflict(queued, {
        ...queued,
        frame: { ...queued.frame, text: "other" },
      })
    ).toBe(true);
    expect(
      inboxRecordsConflict(
        {
          frame: queued.frame,
          fromQid: "2",
          receivedAt: 1,
          v: 1,
        },
        {
          frame: queued.frame,
          fromQid: "2",
          receivedAt: 9,
          v: 1,
        }
      )
    ).toBe(false);
    expect(
      inboxRecordsConflict(
        {
          frame: queued.frame,
          fromQid: "2",
          receivedAt: 1,
          v: 1,
        },
        {
          frame: queued.frame,
          fromQid: "3",
          receivedAt: 1,
          v: 1,
        }
      )
    ).toBe(false);
    expect(
      inboxRecordsConflict(
        {
          frame: queued.frame,
          fromQid: "2",
          receivedAt: 1,
          v: 1,
        },
        {
          frame: { ...queued.frame, text: "other" },
          fromQid: "2",
          receivedAt: 1,
          v: 1,
        }
      )
    ).toBe(true);
  });
});
