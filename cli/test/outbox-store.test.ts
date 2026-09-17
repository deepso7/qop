import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { createCliOutboxStore } from "../src/outbox-store.ts";

const id = "c56a4180-65aa-42ec-a945-5fd21dec0538";

const queuedRecord = {
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

const withTempRoot = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(path.join(tmpdir(), "qop-outbox-"))),
  (root) =>
    Effect.tryPromise({
      catch: () => new Error("cleanup failed"),
      try: () => rm(root, { force: true, recursive: true }),
    }).pipe(Effect.ignore)
);

describe("CLI outbox store", () => {
  it.effect("persists queued records across reload", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot;
      yield* Effect.tryPromise(() => chmod(root, 0o700));
      const store = createCliOutboxStore(root);
      yield* store.enqueue(queuedRecord);
      const reloaded = createCliOutboxStore(root);
      const pending = yield* reloaded.queued();
      expect(pending).toEqual([queuedRecord]);
      expect(yield* reloaded.queuedCount()).toBe(1);
      const info = yield* Effect.tryPromise(() =>
        stat(path.join(root, "outbox.json"))
      );
      expect(info.mode.toString(8).slice(-3)).toBe("600");
    })
  );

  it.effect("treats the same id and content as idempotent", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot;
      const store = createCliOutboxStore(root);
      const first = yield* store.enqueue(queuedRecord);
      const second = yield* store.enqueue({
        ...queuedRecord,
        attempts: 3,
        updatedAt: 9,
      });
      expect(second).toEqual(first);
      expect(yield* store.queuedCount()).toBe(1);
    })
  );

  it.effect("rejects a conflicting payload for an existing id", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot;
      const store = createCliOutboxStore(root);
      yield* store.enqueue(queuedRecord);
      const conflicted = yield* store
        .enqueue({
          ...queuedRecord,
          frame: { ...queuedRecord.frame, text: "other" },
        })
        .pipe(Effect.result);
      expect(conflicted._tag).toBe("Failure");
      if (conflicted._tag === "Failure") {
        expect(conflicted.failure.operation).toBe("conflict");
      }
    })
  );

  it.effect("saves inbox records before they can be acked", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot;
      const store = createCliOutboxStore(root);
      const inbound = {
        frame: queuedRecord.frame,
        fromQid: "2",
        receivedAt: 1_700_000_000_001,
        v: 1 as const,
      };
      yield* store.putInbox(inbound);
      const again = yield* store.putInbox({ ...inbound, receivedAt: 9 });
      expect(again.receivedAt).toBe(1_700_000_000_001);
      const conflicted = yield* store
        .putInbox({ ...inbound, fromQid: "3" })
        .pipe(Effect.result);
      expect(conflicted._tag).toBe("Failure");
    })
  );
});
