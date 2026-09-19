import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { openCliOutboxStore } from "../src/outbox-store.ts";

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
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openCliOutboxStore(root);
          yield* store.enqueue(queuedRecord);
        })
      );
      const reloaded = yield* openCliOutboxStore(root);
      const pending = yield* reloaded.queued();
      expect(pending).toEqual([queuedRecord]);
      expect(yield* reloaded.queuedCount()).toBe(1);
      expect(yield* reloaded.getByIds([queuedRecord.frame.id])).toEqual([
        queuedRecord,
      ]);
      const info = yield* Effect.tryPromise(() =>
        stat(path.join(root, "messages.db"))
      );
      expect(info.mode.toString(8).slice(-3)).toBe("600");
    })
  );

  it.effect("treats the same id and content as idempotent", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot;
      const store = yield* openCliOutboxStore(root);
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
      const store = yield* openCliOutboxStore(root);
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

  it.effect("treats the same inbox id and content as idempotent", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot;
      const store = yield* openCliOutboxStore(root);
      const inbound = {
        frame: queuedRecord.frame,
        fromQid: "2",
        receivedAt: 1_700_000_000_001,
        v: 1 as const,
      };
      const first = yield* store.putInbox(inbound);
      expect(first.inserted).toBe(true);
      expect(yield* store.loadInbox()).toEqual([inbound]);
      const again = yield* store.putInbox({ ...inbound, receivedAt: 9 });
      expect(again.inserted).toBe(false);
      expect(again.record.receivedAt).toBe(1_700_000_000_001);
      const otherSender = yield* store.putInbox({ ...inbound, fromQid: "3" });
      expect(otherSender.inserted).toBe(true);
      expect(yield* store.loadInbox()).toHaveLength(2);
      const conflicted = yield* store
        .putInbox({ ...inbound, frame: { ...inbound.frame, text: "other" } })
        .pipe(Effect.result);
      expect(conflicted._tag).toBe("Failure");
    })
  );

  it.effect("keeps concurrent enqueue and sent marks from dropping rows", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot;
      const store = yield* openCliOutboxStore(root);
      const extraId = "c56a4180-65aa-42ec-a945-5fd21dec0539";
      const extra = {
        ...queuedRecord,
        frame: { ...queuedRecord.frame, id: extraId, text: "later" },
      };
      yield* store.enqueue(queuedRecord);
      yield* Effect.all(
        [
          store.enqueue(extra),
          store.put({ ...queuedRecord, status: "sent", updatedAt: 9 }),
        ],
        { concurrency: 2 }
      );
      const records = yield* store.loadRecords();
      expect(records.map((record) => record.frame.id).toSorted()).toEqual([
        queuedRecord.frame.id,
        extraId,
      ]);
      expect(
        records.find((record) => record.frame.id === queuedRecord.frame.id)
          ?.status
      ).toBe("sent");
    })
  );

  it.effect("persists every concurrent enqueue", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot;
      const store = yield* openCliOutboxStore(root);
      const batch = Array.from({ length: 20 }, (_, index) => ({
        ...queuedRecord,
        frame: {
          ...queuedRecord.frame,
          id: crypto.randomUUID(),
          text: `hello-${index}`,
        },
      }));
      yield* Effect.all(
        batch.map((record) => store.enqueue(record)),
        { concurrency: "unbounded" }
      );
      const records = yield* store.loadRecords();
      expect(records).toHaveLength(20);
      expect(new Set(records.map((record) => record.frame.id)).size).toBe(20);
    })
  );

  it.effect("persists concurrent inbox inserts before ack", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot;
      const store = yield* openCliOutboxStore(root);
      const first = {
        frame: queuedRecord.frame,
        fromQid: "2",
        receivedAt: 1,
        v: 1 as const,
      };
      const second = {
        frame: {
          ...queuedRecord.frame,
          id: "c56a4180-65aa-42ec-a945-5fd21dec0539",
          text: "other",
        },
        fromQid: "3",
        receivedAt: 2,
        v: 1 as const,
      };
      yield* Effect.all([store.putInbox(first), store.putInbox(second)], {
        concurrency: 2,
      });
      const messages = yield* store.loadInbox();
      expect(messages.map((item) => item.frame.id).toSorted()).toEqual([
        first.frame.id,
        second.frame.id,
      ]);
    })
  );

  it.effect("treats concurrent enqueue of the same id as one row", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot;
      const store = yield* openCliOutboxStore(root);
      const results = yield* Effect.all(
        Array.from({ length: 8 }, () => store.enqueue(queuedRecord)),
        { concurrency: "unbounded" }
      );
      expect(results).toEqual(Array.from({ length: 8 }, () => queuedRecord));
      expect(yield* store.queuedCount()).toBe(1);
    })
  );

  it.effect("preserves queued insertion order across reload", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot;
      const first = queuedRecord;
      const second = {
        ...queuedRecord,
        frame: {
          ...queuedRecord.frame,
          id: "c56a4180-65aa-42ec-a945-5fd21dec0539",
          text: "second",
        },
      };
      const third = {
        ...queuedRecord,
        frame: {
          ...queuedRecord.frame,
          id: "c56a4180-65aa-42ec-a945-5fd21dec053a",
          text: "third",
        },
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openCliOutboxStore(root);
          yield* store.enqueue(first);
          yield* store.enqueue(second);
          yield* store.enqueue(third);
        })
      );
      const reloaded = yield* openCliOutboxStore(root);
      const pending = yield* reloaded.queued();
      expect(pending.map((record) => record.frame.id)).toEqual([
        first.frame.id,
        second.frame.id,
        third.frame.id,
      ]);
    })
  );

  it.effect("refuses an existing messages.db that is not mode 600", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot;
      const dbPath = path.join(root, "messages.db");
      yield* Effect.tryPromise(() => writeFile(dbPath, "", { mode: 0o644 }));
      yield* Effect.tryPromise(() => chmod(dbPath, 0o644));
      const opened = yield* openCliOutboxStore(root).pipe(Effect.result);
      expect(opened._tag).toBe("Failure");
      if (opened._tag === "Failure") {
        expect(opened.failure.operation).toBe("permissions");
      }
    })
  );

  it.effect("refuses a messages.db with an unsupported schema version", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot;
      const dbPath = path.join(root, "messages.db");
      const raw = new DatabaseSync(dbPath);
      raw.exec("PRAGMA user_version = 99");
      raw.close();
      yield* Effect.tryPromise(() => chmod(dbPath, 0o600));
      const opened = yield* openCliOutboxStore(root).pipe(Effect.result);
      expect(opened._tag).toBe("Failure");
      if (opened._tag === "Failure") {
        expect(opened.failure.operation).toBe("decode");
      }
    })
  );
});
