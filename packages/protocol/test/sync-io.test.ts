import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { readSyncRequestFrom, writeSyncRequestTo } from "../src/sync-io.ts";

const id = "c56a4180-65aa-42ec-a945-5fd21dec0538";

describe("sync stream frames", () => {
  it.effect("writes then reads a half-closed held-bound handoff", () =>
    Effect.gen(function* () {
      const frame = {
        composedBy: `0x${"aa".repeat(32)}`,
        record: {
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
        },
        type: "handoff" as const,
        v: 1 as const,
      };
      const pending: (Uint8Array | undefined)[] = [];
      const stream = {
        closeWrite: () => {},
        connId: 1,
        peerId: "peer",
        read: () => Promise.resolve(pending.shift()),
        reset: () => {},
        write: (data: Uint8Array) => {
          pending.push(data);
        },
      };
      yield* writeSyncRequestTo(stream, frame);
      pending.push(undefined);
      const decoded = yield* readSyncRequestFrom(stream);
      assert.strictEqual(decoded.type, "handoff");
      if (decoded.type === "handoff") {
        assert.strictEqual(decoded.record.frame.id, id);
      }
    })
  );
});
