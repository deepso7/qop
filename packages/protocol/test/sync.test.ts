import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  decodeSyncRequestV1,
  decodeSyncResponseV1,
  encodeSyncRequestV1,
  encodeSyncResponseV1,
  MAX_SYNC_PAYLOAD_BYTES,
  SyncCatchupV1,
  SyncCodecError,
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
      receipts: [{ deliveredAt: 1_700_000_000_100, id, toQid: "1" }],
      type: "receipts" as const,
      v: 1 as const,
    };
    const encoded = await Effect.runPromise(encodeSyncResponseV1(receipts));
    expect(await Effect.runPromise(decodeSyncResponseV1(encoded))).toEqual(
      receipts
    );
  });

  it("rejects a receipt that omits toQid", async () => {
    const result = await Effect.runPromise(
      decodeSyncResponseV1(
        new TextEncoder().encode(
          JSON.stringify({
            receipts: [{ deliveredAt: 1_700_000_000_100, id }],
            type: "receipts",
            v: 1,
          })
        )
      ).pipe(Effect.result)
    );
    expect(result._tag).toBe("Failure");
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

  it("round-trips catch-up and inbox frames", async () => {
    const catchup = { after: 0, type: "catchup" as const, v: 1 as const };
    const encodedCatchup = await Effect.runPromise(
      encodeSyncRequestV1(catchup)
    );
    expect(
      await Effect.runPromise(decodeSyncRequestV1(encodedCatchup))
    ).toEqual(catchup);
    const inbox = {
      records: [
        {
          record: {
            frame: queued.frame,
            fromQid: "2",
            receivedAt: 1_700_000_000_100,
            v: 1 as const,
          },
          seq: 4,
        },
      ],
      type: "inbox" as const,
      v: 1 as const,
    };
    const encoded = await Effect.runPromise(encodeSyncResponseV1(inbox));
    expect(await Effect.runPromise(decodeSyncResponseV1(encoded))).toEqual(
      inbox
    );
  });

  it("rejects a negative or non-integer catch-up cursor", async () => {
    const results = await Promise.all(
      [-1, 1.5].map((after) =>
        Effect.runPromise(
          Schema.decodeUnknownEffect(SyncCatchupV1)({
            after,
            type: "catchup",
            v: 1,
          }).pipe(Effect.result)
        )
      )
    );
    expect(results.map((result) => result._tag)).toEqual([
      "Failure",
      "Failure",
    ]);
  });

  it("rejects an inbox frame above 64 KB as oversized", async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        records: [
          {
            record: {
              frame: { ...queued.frame, text: "x".repeat(70_000) },
              fromQid: "2",
              receivedAt: 1,
              v: 1,
            },
            seq: 1,
          },
        ],
        type: "inbox",
        v: 1,
      })
    );
    expect(bytes.byteLength).toBeGreaterThan(MAX_SYNC_PAYLOAD_BYTES);
    const result = await Effect.runPromise(
      decodeSyncResponseV1(bytes).pipe(Effect.result)
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(SyncCodecError);
      expect(result.failure.operation).toBe("oversized");
    }
  });

  it("does not treat a 16 KB text inbox record as oversized", async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        records: [
          {
            record: {
              frame: { ...queued.frame, text: "a".repeat(16 * 1024) },
              fromQid: "2",
              receivedAt: 1,
              v: 1,
            },
            seq: 1,
          },
        ],
        type: "inbox",
        v: 1,
      })
    );
    expect(bytes.byteLength).toBeGreaterThan(16 * 1024);
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_SYNC_PAYLOAD_BYTES);
    const result = await Effect.runPromise(
      decodeSyncResponseV1(bytes).pipe(Effect.result)
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(SyncCodecError);
      // Chat text is capped at 4,000 characters, so schema rejects the body
      // after the sync cap has already accepted the frame.
      expect(result.failure.operation).toBe("frame");
    }
  });

  it("rejects a handoff that is not a queued outbox record", async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknownEffect(SyncHandoffV1)({
        ...handoff,
        record: { ...queued, status: "sent" },
      }).pipe(Effect.result)
    );
    expect(result._tag).toBe("Failure");
  });
});
