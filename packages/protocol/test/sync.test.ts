import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  assertHeldMatches,
  decodeSyncRequestV1,
  decodeSyncResponseV1,
  encodeSyncRequestV1,
  encodeSyncResponseV1,
  SyncHandoffV1,
  SyncPollV1,
} from "../src/sync.ts";

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

const handoff = {
  composedBy: `0x${"aa".repeat(32)}`,
  record: queued,
  type: "handoff" as const,
  v: 1 as const,
};

describe("sync frames", () => {
  it("round-trips a handoff request", async () => {
    const encoded = await Effect.runPromise(encodeSyncRequestV1(handoff));
    const decoded = await Effect.runPromise(decodeSyncRequestV1(encoded));
    expect(decoded).toEqual(handoff);
  });

  it("round-trips a poll and receipts", async () => {
    const poll = {
      ids: [id],
      type: "poll" as const,
      v: 1 as const,
    };
    const encodedPoll = await Effect.runPromise(encodeSyncRequestV1(poll));
    expect(await Effect.runPromise(decodeSyncRequestV1(encodedPoll))).toEqual(
      poll
    );
    const receipts = {
      receipts: [{ deliveredAt: 1_700_000_000_100, id }],
      type: "receipts" as const,
      v: 1 as const,
    };
    const encoded = await Effect.runPromise(encodeSyncResponseV1(receipts));
    expect(await Effect.runPromise(decodeSyncResponseV1(encoded))).toEqual(
      receipts
    );
  });

  it("rejects an unknown request type", async () => {
    const result = await Effect.runPromise(
      decodeSyncRequestV1(
        new TextEncoder().encode(JSON.stringify({ id, type: "inbox", v: 1 }))
      ).pipe(Effect.result)
    );
    expect(result._tag).toBe("Failure");
  });

  it("rejects a poll with no ids", async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknownEffect(SyncPollV1)({
        ids: [],
        type: "poll",
        v: 1,
      }).pipe(Effect.result)
    );
    expect(result._tag).toBe("Failure");
  });

  it("rejects a handoff that is not a queued outbox record", async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknownEffect(SyncHandoffV1)({
        ...handoff,
        record: { ...queued, status: "held" },
      }).pipe(Effect.result)
    );
    expect(result._tag).toBe("Failure");
  });

  it("asserts a held id matches the handed-off message", () => {
    expect(() =>
      assertHeldMatches({ id, type: "held", v: 1 }, id)
    ).not.toThrow();
    expect(() =>
      assertHeldMatches(
        { id: "c56a4180-65aa-42ec-a945-5fd21dec0539", type: "held", v: 1 },
        id
      )
    ).toThrow(/held does not match/u);
  });
});
