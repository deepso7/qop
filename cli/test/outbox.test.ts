import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import type { OutboxRecordV1, RegistryAccount } from "@qop/protocol";
import { Deferred, Effect, Fiber } from "effect";

import {
  CliOutboxStoreError,
  openCliOutboxStore,
} from "../src/outbox-store.ts";
import {
  CliOutboxDeliverError,
  createOutboxRuntime,
  describeOutboxEvent,
  nextAttemptDelayMs,
  OUTBOX_INITIAL_BACKOFF_MS,
  OUTBOX_MAX_BACKOFF_MS,
} from "../src/outbox.ts";

const PEER_BOB = "12D3KooWC7cDcNR4J3NC9y1gTkqafZKmnjCUvrRMxU2LMugGJGgy";
const PEER_CAROL = "12D3KooWDGEF3VLEM7R3XWGJsqPCcSSjwRmuNw6JTQMVMNSSzwAz";
const bobDeviceKey = `0x${"22".repeat(32)}`;
const carolDeviceKey = `0x${"33".repeat(32)}`;
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

const carolAccount: RegistryAccount = {
  ...account,
  deviceKey: carolDeviceKey,
  devices: [{ deviceKey: carolDeviceKey, peerId: PEER_CAROL }],
  handle: "carol",
  peerId: PEER_CAROL,
  qid: 2n,
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
      const store = yield* openCliOutboxStore(root);
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
      const store = yield* openCliOutboxStore(root);
      const attempts: number[] = [];
      let now = 1000;
      let fail = true;
      const outbox = createOutboxRuntime({
        deliver: () => {
          attempts.push(now);
          return fail
            ? Effect.fail(new CliOutboxDeliverError({ operation: "transport" }))
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
      expect(waiting[0]?.lastError).toBe("transport");
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
      const store = yield* openCliOutboxStore(root);
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
      const store = yield* openCliOutboxStore(root);
      const kinds: string[] = [];
      const first = createOutboxRuntime({
        deliver: () =>
          Effect.fail(new CliOutboxDeliverError({ operation: "transport" })),
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

  it.effect("retries immediately on a connection flush during backoff", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot;
      const store = yield* openCliOutboxStore(root);
      const attempts: number[] = [];
      let now = 1000;
      const outbox = createOutboxRuntime({
        deliver: () => {
          attempts.push(now);
          return Effect.fail(
            new CliOutboxDeliverError({ operation: "transport" })
          );
        },
        lookupHandle: () => Effect.succeed(account),
        now: () => now,
        store,
      });
      yield* outbox.enqueue({ frame, toHandle: "bob", toQid: "1" });
      yield* outbox.flushDue();
      expect(attempts).toEqual([1000]);
      now += 1;
      yield* outbox.flushDue();
      expect(attempts).toEqual([1000]);
      yield* outbox.flushDue({ ignoreBackoffForQid: "1" });
      expect(attempts).toEqual([1000, now]);
      const waiting = yield* store.queued();
      expect(waiting[0]?.status).toBe("queued");
      expect(waiting[0]?.attempts).toBe(2);
    })
  );

  it.effect(
    "delivers same-recipient messages in order and not concurrently",
    () =>
      Effect.gen(function* () {
        const root = yield* withTempRoot;
        const store = yield* openCliOutboxStore(root);
        const otherId = "c56a4180-65aa-42ec-a945-5fd21dec0539";
        const thirdId = "c56a4180-65aa-42ec-a945-5fd21dec053a";
        let active = 0;
        let maxActive = 0;
        const delivered: string[] = [];
        const outbox = createOutboxRuntime({
          deliver: (record) =>
            Effect.gen(function* () {
              active += 1;
              maxActive = Math.max(maxActive, active);
              yield* Effect.yieldNow;
              delivered.push(record.frame.id);
              active -= 1;
            }),
          lookupHandle: () => Effect.succeed(account),
          now: () => 1000,
          store,
        });
        yield* outbox.enqueue({ frame, toHandle: "bob", toQid: "1" });
        yield* outbox.enqueue({
          frame: { ...frame, id: otherId, text: "second" },
          toHandle: "bob",
          toQid: "1",
        });
        yield* outbox.enqueue({
          frame: { ...frame, id: thirdId, text: "third" },
          toHandle: "bob",
          toQid: "1",
        });
        yield* outbox.flushDue();
        expect(maxActive).toBe(1);
        expect(delivered).toEqual([id, otherId, thirdId]);
        expect(yield* store.queued()).toEqual([]);
      })
  );

  it.effect(
    "keeps same-recipient order when a poll flush overlaps a connection flush",
    () =>
      Effect.gen(function* () {
        const root = yield* withTempRoot;
        const store = yield* openCliOutboxStore(root);
        const otherId = "c56a4180-65aa-42ec-a945-5fd21dec0539";
        const thirdId = "c56a4180-65aa-42ec-a945-5fd21dec053a";
        const aStarted = yield* Deferred.make<boolean>();
        const releaseA = yield* Deferred.make<boolean>();
        const delivered: string[] = [];
        const outbox = createOutboxRuntime({
          deliver: (record) =>
            Effect.gen(function* () {
              if (record.frame.id === id) {
                yield* Deferred.succeed(aStarted, true);
                yield* Deferred.await(releaseA);
              }
              delivered.push(record.frame.id);
            }),
          lookupHandle: () => Effect.succeed(account),
          now: () => 1000,
          store,
        });
        yield* outbox.enqueue({ frame, toHandle: "bob", toQid: "1" });
        yield* outbox.enqueue({
          frame: { ...frame, id: otherId, text: "second" },
          toHandle: "bob",
          toQid: "1",
        });
        yield* outbox.enqueue({
          frame: { ...frame, id: thirdId, text: "third" },
          toHandle: "bob",
          toQid: "1",
        });
        const poll = yield* Effect.forkChild(outbox.flushDue());
        yield* Deferred.await(aStarted);
        const connection = yield* Effect.forkChild(
          outbox.flushOnConnection(Effect.succeed("1"))
        );
        yield* Fiber.join(connection).pipe(
          Effect.timeoutOrElse({
            duration: 2000,
            orElse: () =>
              Effect.fail(
                new Error(
                  "connection flush blocked behind an in-flight recipient"
                )
              ),
          })
        );
        expect(delivered).toEqual([]);
        yield* Deferred.succeed(releaseA, true);
        yield* Fiber.join(poll);
        expect(delivered).toEqual([id, otherId, thirdId]);
        expect(yield* store.queued()).toEqual([]);
      })
  );

  it.effect(
    "delivers a reachable recipient while another delivery is still in flight",
    () =>
      Effect.gen(function* () {
        const root = yield* withTempRoot;
        const store = yield* openCliOutboxStore(root);
        const carolStarted = yield* Deferred.make<boolean>();
        const bobDelivered = yield* Deferred.make<boolean>();
        const releaseCarol = yield* Deferred.make<boolean>();
        const delivered: string[] = [];
        const carolId = "c56a4180-65aa-42ec-a945-5fd21dec0539";
        const outbox = createOutboxRuntime({
          deliver: (record) => {
            if (record.toHandle === "carol") {
              return Effect.gen(function* () {
                yield* Deferred.succeed(carolStarted, true);
                yield* Deferred.await(releaseCarol);
                delivered.push(record.frame.id);
              });
            }
            return Effect.gen(function* () {
              delivered.push(record.frame.id);
              yield* Deferred.succeed(bobDelivered, true);
            });
          },
          lookupHandle: (handle) =>
            Effect.succeed(handle === "carol" ? carolAccount : account),
          now: () => 1000,
          store,
        });
        yield* outbox.enqueue({
          frame: { ...frame, id: carolId, text: "offline" },
          toHandle: "carol",
          toQid: "2",
        });
        yield* outbox.enqueue({ frame, toHandle: "bob", toQid: "1" });
        const flush = yield* Effect.forkChild(outbox.flushDue());
        yield* Deferred.await(carolStarted);
        yield* Deferred.await(bobDelivered);
        expect(delivered).toEqual([id]);
        yield* Deferred.succeed(releaseCarol, true);
        yield* Fiber.join(flush);
        expect(delivered).toEqual([id, carolId]);
        expect(yield* store.queued()).toEqual([]);
      })
  );

  it.effect("keeps backoff for records unrelated to a connection flush", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot;
      const store = yield* openCliOutboxStore(root);
      const attempts: string[] = [];
      let now = 1000;
      const outbox = createOutboxRuntime({
        deliver: (record) => {
          attempts.push(record.toHandle);
          return Effect.fail(
            new CliOutboxDeliverError({ operation: "transport" })
          );
        },
        lookupHandle: (handle) =>
          Effect.succeed(handle === "carol" ? carolAccount : account),
        now: () => now,
        store,
      });
      yield* outbox.enqueue({ frame, toHandle: "bob", toQid: "1" });
      yield* outbox.flushDue();
      expect(attempts).toEqual(["bob"]);
      now += 1;
      yield* outbox.flushDue({ ignoreBackoffForQid: "2" });
      expect(attempts).toEqual(["bob"]);
      yield* outbox.flushDue({ ignoreBackoffForQid: "1" });
      expect(attempts).toEqual(["bob", "bob"]);
    })
  );

  it.effect(
    "does not interrupt a sibling delivery when one store put fails",
    () =>
      Effect.gen(function* () {
        const root = yield* withTempRoot;
        const inner = yield* openCliOutboxStore(root);
        const bobStarted = yield* Deferred.make<boolean>();
        const releaseBob = yield* Deferred.make<boolean>();
        const events: string[] = [];
        const carolId = "c56a4180-65aa-42ec-a945-5fd21dec0539";
        const store = {
          ...inner,
          put: (record: OutboxRecordV1) =>
            record.frame.id === carolId && record.status === "sent"
              ? Effect.fail(new CliOutboxStoreError({ operation: "write" }))
              : inner.put(record),
        };
        const outbox = createOutboxRuntime({
          deliver: (record) => {
            if (record.toHandle === "bob") {
              return Effect.gen(function* () {
                yield* Deferred.succeed(bobStarted, true);
                yield* Deferred.await(releaseBob);
              });
            }
            return Effect.gen(function* () {
              yield* Deferred.await(bobStarted);
            });
          },
          lookupHandle: (handle) =>
            Effect.succeed(handle === "carol" ? carolAccount : account),
          now: () => 1000,
          onEvent: (event) => {
            events.push(event.kind);
          },
          store,
        });
        yield* outbox.enqueue({ frame, toHandle: "bob", toQid: "1" });
        yield* outbox.enqueue({
          frame: { ...frame, id: carolId, text: "offline" },
          toHandle: "carol",
          toQid: "2",
        });
        const flush = yield* Effect.forkChild(outbox.flushDue());
        yield* Deferred.await(bobStarted);
        yield* Deferred.succeed(releaseBob, true);
        yield* Fiber.join(flush);
        const records = yield* inner.loadRecords();
        expect(records.find((record) => record.frame.id === id)?.status).toBe(
          "sent"
        );
        expect(
          records.find((record) => record.frame.id === carolId)?.status
        ).toBe("queued");
        expect(events).toContain("store-error");
      })
  );

  it.effect("skips a connection lookup when nothing is queued", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot;
      const store = yield* openCliOutboxStore(root);
      let lookups = 0;
      const outbox = createOutboxRuntime({
        deliver: () => Effect.void,
        lookupHandle: () => Effect.succeed(account),
        now: () => 1000,
        store,
      });
      yield* outbox.flushOnConnection(
        Effect.sync(() => {
          lookups += 1;
          return "1";
        })
      );
      expect(lookups).toBe(0);
    })
  );

  it.effect(
    "skips a connection lookup when every queued record is already due",
    () =>
      Effect.gen(function* () {
        const root = yield* withTempRoot;
        const store = yield* openCliOutboxStore(root);
        let lookups = 0;
        const delivered: string[] = [];
        const outbox = createOutboxRuntime({
          deliver: (record) =>
            Effect.sync(() => {
              delivered.push(record.frame.id);
            }),
          lookupHandle: () => Effect.succeed(account),
          now: () => 1000,
          store,
        });
        yield* outbox.enqueue({ frame, toHandle: "bob", toQid: "1" });
        yield* outbox.flushOnConnection(
          Effect.sync(() => {
            lookups += 1;
            return "1";
          })
        );
        expect(lookups).toBe(0);
        expect(delivered).toEqual([id]);
      })
  );

  it.effect(
    "looks up a connected qid only to skip backoff for waiting records",
    () =>
      Effect.gen(function* () {
        const root = yield* withTempRoot;
        const store = yield* openCliOutboxStore(root);
        let lookups = 0;
        const attempts: number[] = [];
        let now = 1000;
        const outbox = createOutboxRuntime({
          deliver: () => {
            attempts.push(now);
            return Effect.fail(
              new CliOutboxDeliverError({ operation: "transport" })
            );
          },
          lookupHandle: () => Effect.succeed(account),
          now: () => now,
          store,
        });
        yield* outbox.enqueue({ frame, toHandle: "bob", toQid: "1" });
        yield* outbox.flushDue();
        expect(attempts).toEqual([1000]);
        now += 1;
        yield* outbox.flushOnConnection(
          Effect.sync(() => {
            lookups += 1;
            return "1";
          })
        );
        expect(lookups).toBe(1);
        expect(attempts).toEqual([1000, now]);
      })
  );

  it.effect(
    "announces a repeated store error once until the store recovers",
    () =>
      Effect.gen(function* () {
        const root = yield* withTempRoot;
        const inner = yield* openCliOutboxStore(root);
        const events: string[] = [];
        let failQueued = true;
        const store = {
          ...inner,
          queued: () =>
            failQueued
              ? Effect.fail(new CliOutboxStoreError({ operation: "read" }))
              : inner.queued(),
        };
        const outbox = createOutboxRuntime({
          deliver: () => Effect.void,
          lookupHandle: () => Effect.succeed(account),
          now: () => 1000,
          onEvent: (event) => {
            events.push(event.kind);
          },
          store,
        });
        yield* outbox.flushOnConnection(Effect.succeed("1"));
        yield* outbox.flushOnConnection(Effect.succeed("1"));
        expect(events).toEqual(["store-error"]);
        failQueued = false;
        yield* outbox.enqueue({ frame, toHandle: "bob", toQid: "1" });
        yield* outbox.flushDue();
        expect(events).toEqual(["store-error", "queued", "sent"]);
        failQueued = true;
        yield* outbox.flushOnConnection(Effect.succeed("1"));
        expect(events).toEqual([
          "store-error",
          "queued",
          "sent",
          "store-error",
        ]);
      })
  );

  it("includes the waiting reason in operator copy", () => {
    expect(
      describeOutboxEvent({
        handle: "bob",
        kind: "waiting",
        reason: "timeout",
      })
    ).toContain("timeout");
    expect(
      describeOutboxEvent({
        kind: "store-error",
        reason: "Could not write the CLI outbox or inbox.",
      })
    ).toBe("Could not write the CLI outbox or inbox.");
  });
});
