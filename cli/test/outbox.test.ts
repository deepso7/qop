import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import type { RegistryAccount } from "@qop/protocol";
import { Effect } from "effect";

import { createCliOutboxStore } from "../src/outbox-store.ts";
import {
  createOutboxRuntime,
  nextAttemptDelayMs,
  OUTBOX_INITIAL_BACKOFF_MS,
  OUTBOX_MAX_BACKOFF_MS,
} from "../src/outbox.ts";

const PEER_BOB = "12D3KooWC7cDcNR4J3NC9y1gTkqafZKmnjCUvrRMxU2LMugGJGgy";
const bobDeviceKey = `0x${"22".repeat(32)}`;
const id = "c56a4180-65aa-42ec-a945-5fd21dec0538";

const account: RegistryAccount = {
  blockNumber: 1n,
  deviceKey: bobDeviceKey,
  devices: [{ deviceKey: bobDeviceKey, peerId: PEER_BOB }],
  freshness: "fresh",
  handle: "bob",
  nonce: 0n,
  owner: "0x0000000000000000000000000000000000000001",
  ownerVersion: 0,
  peerId: PEER_BOB,
  qid: 1n,
  registeredAt: 1n,
};

const frame = {
  fromHandle: "alice",
  id,
  sentAt: 1_700_000_000_000,
  text: "hello",
  v: 1 as const,
};

const withTempRoot = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(path.join(tmpdir(), "qop-outbox-rt-"))),
  (root) =>
    Effect.tryPromise({
      catch: () => new Error("cleanup failed"),
      try: () => rm(root, { force: true, recursive: true }),
    }).pipe(Effect.ignore)
);

describe("CLI outbox retry", () => {
  it("caps exponential backoff at one minute", () => {
    expect(nextAttemptDelayMs(0)).toBe(0);
    expect(nextAttemptDelayMs(1)).toBe(OUTBOX_INITIAL_BACKOFF_MS);
    expect(nextAttemptDelayMs(2)).toBe(4000);
    expect(nextAttemptDelayMs(20)).toBe(OUTBOX_MAX_BACKOFF_MS);
  });

  it.effect("marks a delivered message sent and does not resend it", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot;
      const store = createCliOutboxStore(root);
      const delivered: string[] = [];
      const events: string[] = [];
      let now = 1000;
      const outbox = createOutboxRuntime({
        deliver: (record) =>
          Effect.sync(() => {
            delivered.push(record.frame.id);
          }),
        lookupHandle: () => Effect.succeed(account),
        now: () => now,
        onEvent: (event) => {
          events.push(event.kind);
        },
        store,
      });
      yield* outbox.enqueue({
        frame,
        toHandle: "bob",
        toQid: "1",
      });
      yield* outbox.flushDue();
      expect(delivered).toEqual([id]);
      expect(events).toEqual(["queued", "sent"]);
      now += 60_000;
      yield* outbox.flushDue();
      expect(delivered).toEqual([id]);
      const pending = yield* store.queued();
      expect(pending).toEqual([]);
    })
  );

  it.effect("keeps an offline send queued and retries after backoff", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot;
      const store = createCliOutboxStore(root);
      const attempts: number[] = [];
      let now = 1000;
      let fail = true;
      const outbox = createOutboxRuntime({
        deliver: () => {
          attempts.push(now);
          return fail
            ? Effect.fail(new Error("connect deadline elapsed"))
            : Effect.void;
        },
        lookupHandle: () => Effect.succeed(account),
        now: () => now,
        store,
      });
      yield* outbox.enqueue({
        frame,
        toHandle: "bob",
        toQid: "1",
      });
      yield* outbox.flushDue();
      expect(attempts).toEqual([1000]);
      const waiting = yield* store.queued();
      expect(waiting[0]?.status).toBe("queued");
      expect(waiting[0]?.attempts).toBe(1);
      expect(waiting[0]?.lastError).toContain("connect deadline");
      now += OUTBOX_INITIAL_BACKOFF_MS - 1;
      yield* outbox.flushDue();
      expect(attempts).toEqual([1000]);
      fail = false;
      now += 1;
      yield* outbox.flushDue();
      expect(attempts).toEqual([1000, now]);
      expect(yield* store.queued()).toEqual([]);
    })
  );

  it.effect("fails when the handle now belongs to another account", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot;
      const store = createCliOutboxStore(root);
      let delivered = 0;
      const outbox = createOutboxRuntime({
        deliver: () =>
          Effect.sync(() => {
            delivered += 1;
          }),
        lookupHandle: () => Effect.succeed({ ...account, qid: 99n }),
        now: () => 1000,
        store,
      });
      yield* outbox.enqueue({
        frame,
        toHandle: "bob",
        toQid: "1",
      });
      yield* outbox.flushDue();
      expect(delivered).toBe(0);
      const records = yield* store.loadRecords();
      expect(records[0]?.status).toBe("failed");
      expect(records[0]?.lastError).toContain("different account");
    })
  );

  it.effect("announces existing queued messages on resume", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot;
      const store = createCliOutboxStore(root);
      const kinds: string[] = [];
      const first = createOutboxRuntime({
        deliver: () => Effect.fail(new Error("offline")),
        lookupHandle: () => Effect.succeed(account),
        now: () => 1000,
        store,
      });
      yield* first.enqueue({ frame, toHandle: "bob", toQid: "1" });
      yield* first.flushDue();
      const restarted = createOutboxRuntime({
        deliver: () => Effect.void,
        lookupHandle: () => Effect.succeed(account),
        now: () => 1000,
        onEvent: (event) => {
          kinds.push(event.kind);
        },
        store,
      });
      expect(yield* restarted.resume()).toBe(1);
      expect(kinds).toEqual(["resumed"]);
    })
  );
});
