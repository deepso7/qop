import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect } from "effect";

import { openChatStore } from "../src/chat.ts";
import { openCliOutboxStore } from "../src/outbox-store.ts";

const inbound = {
  frame: {
    fromHandle: "bob",
    id: "c56a4180-65aa-42ec-a945-5fd21dec0538",
    sentAt: 1_700_000_000_000,
    text: "hello",
    v: 1 as const,
  },
  fromQid: "1",
  receivedAt: 1_700_000_000_001,
  v: 1 as const,
};

const withTempRoot = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(path.join(tmpdir(), "qop-chat-store-"))),
  (root) =>
    Effect.tryPromise({
      catch: () => new Error("cleanup failed"),
      try: () => rm(root, { force: true, recursive: true }),
    }).pipe(Effect.ignore)
);

describe("chat store handlers", () => {
  it.effect("interrupts forked handlers before closing messages.db", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot;
      yield* Effect.tryPromise(() => chmod(root, 0o700));
      const waiting = yield* Deferred.make<boolean>();
      const latch = yield* Deferred.make<boolean>();
      let writeError: unknown;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { messages, runHandler } = yield* openChatStore(root);
          runHandler(
            Effect.gen(function* () {
              yield* Deferred.succeed(waiting, true);
              yield* Deferred.await(latch);
              yield* messages.putInbox(inbound).pipe(
                Effect.catchTag("CliOutboxStoreError", (error) =>
                  Effect.sync(() => {
                    writeError = error;
                  })
                )
              );
            })
          );
          yield* Deferred.await(waiting);
        })
      );
      yield* Deferred.succeed(latch, true);
      yield* Effect.yieldNow;
      expect(writeError).toBeUndefined();
      const inbox = yield* Effect.scoped(
        openCliOutboxStore(root).pipe(
          Effect.flatMap((store) => store.loadInbox())
        )
      );
      expect(inbox).toEqual([]);
    })
  );
});
