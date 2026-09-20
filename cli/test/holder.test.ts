import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { deviceKeyFromPeerId, Hex32, PeerId } from "@qop/identity";
import {
  CHAT_PROTOCOL,
  createLifecycleAdapter,
  createPeerSessions,
  encodeAck,
  encodeSyncRequestV1,
  SYNC_PROTOCOL,
} from "@qop/protocol";
import type { OutboxRecordV1, RegistryAccount } from "@qop/protocol";
import { Deferred, Effect, Schema } from "effect";
import { vi } from "vitest";

import {
  createHolder,
  MAX_INBOUND_STREAMS,
  UNREADABLE_INBOUND_CHAT,
} from "../src/chat.ts";
import type { ChatStream, HolderEndpoint } from "../src/chat.ts";
import { openCliOutboxStore } from "../src/outbox-store.ts";

const PEER_BOB = "12D3KooWC7cDcNR4J3NC9y1gTkqafZKmnjCUvrRMxU2LMugGJGgy";
const PEER_CAROL = "12D3KooWDGEF3VLEM7R3XWGJsqPCcSSjwRmuNw6JTQMVMNSSzwAz";
const bobDeviceKey = `0x${"22".repeat(32)}`;

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

const identity = {
  handle: "alice",
  peerId: PEER_BOB,
  qid: "1",
};

const withTempRoot = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(path.join(tmpdir(), "qop-holder-"))),
  (root) =>
    Effect.tryPromise({
      catch: () => new Error("cleanup failed"),
      try: () => rm(root, { force: true, recursive: true }),
    }).pipe(Effect.ignore)
);

const makeLifecycle = () => ({
  adapter: createLifecycleAdapter({
    monotonicNow: () => performance.now(),
    wallNow: () => Date.now(),
  }),
  dispose: () => {
    // Tests do not arm SIGCONT / intervals.
  },
  handleWake: () => {
    // Unused.
  },
});

const makeSessions = () =>
  createPeerSessions({
    getContactByQid: () => Promise.resolve(null),
    lookupDeviceKey: () => Effect.succeed(account),
    lookupHandle: () => Effect.succeed(account),
    ownQid: () => identity.qid,
    upsertContact: () => Promise.resolve(),
  });

const makeStream = (protocolId: string, read?: ChatStream["read"]) => ({
  closeWrite: vi.fn(),
  connId: 3,
  peerId: PEER_BOB,
  protocolId,
  read: vi.fn(read),
  reset: vi.fn(),
  write: vi.fn(),
});

const makeEndpoint = () => {
  const listeners = new Map<string, ((value: ChatStream) => void)[]>();
  const openStream = vi.fn();
  const endpoint: HolderEndpoint & {
    emit: (event: string, value: ChatStream) => void;
    openStream: typeof openStream;
  } = {
    close: vi.fn(),
    connect: vi.fn().mockResolvedValue({}),
    connectedPeers: vi.fn((): string[] => []),
    emit: (event, value) => {
      for (const listener of listeners.get(event) ?? []) {
        listener(value);
      }
    },
    on: vi.fn((event: string, listener: (value: ChatStream) => void) => {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    }),
    openStream,
    waitPeerReady: vi.fn().mockResolvedValue({}),
  };
  return endpoint;
};

const makeOut = (ready: Deferred.Deferred<boolean, never>) => {
  const errors: string[] = [];
  const lines: string[] = [];
  return {
    errors,
    lines,
    out: {
      error: (line: string) => {
        errors.push(line);
      },
      log: (line: string) => {
        lines.push(line);
        if (line.startsWith("CLI messaging ready")) {
          Effect.runSync(Deferred.succeed(ready, true));
        }
      },
    },
  };
};

describe("createHolder", () => {
  it.live("resets and logs a malformed inbound chat frame", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot;
      yield* Effect.tryPromise(() => chmod(root, 0o700));
      const endpoint = makeEndpoint();
      const ready = yield* Deferred.make<boolean>();
      const reset = yield* Deferred.make<boolean>();
      const { errors, out } = makeOut(ready);
      const unread: (Uint8Array | undefined)[] = [
        new TextEncoder().encode("{not-a-frame"),
      ];
      const stream = makeStream(CHAT_PROTOCOL, async () => {
        await Promise.resolve();
        return unread.shift();
      });
      stream.reset.mockImplementation(() => {
        Effect.runSync(Deferred.succeed(reset, true));
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const messages = yield* openCliOutboxStore(root);
          yield* Effect.forkChild(
            createHolder({
              endpoint,
              identity,
              lifecycle: makeLifecycle(),
              messages,
              out,
              reader: {
                lookupDeviceKey: () => Effect.succeed(account),
                lookupHandle: () => Effect.succeed(account),
              },
              sessions: makeSessions(),
            })
          );
          yield* Deferred.await(ready);
          endpoint.emit("stream", stream);
          yield* Deferred.await(reset);
        })
      );

      expect(stream.reset).toHaveBeenCalledOnce();
      expect(stream.write).not.toHaveBeenCalled();
      expect(errors).toContain(UNREADABLE_INBOUND_CHAT);
    })
  );

  it.live("resets an unknown protocol without starting a handler", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot;
      yield* Effect.tryPromise(() => chmod(root, 0o700));
      const endpoint = makeEndpoint();
      const ready = yield* Deferred.make<boolean>();
      const { errors, out } = makeOut(ready);
      const stream = makeStream("/unknown/1");

      yield* Effect.scoped(
        Effect.gen(function* () {
          const messages = yield* openCliOutboxStore(root);
          yield* Effect.forkChild(
            createHolder({
              endpoint,
              identity,
              lifecycle: makeLifecycle(),
              messages,
              out,
              reader: {
                lookupDeviceKey: () => Effect.succeed(account),
                lookupHandle: () => Effect.succeed(account),
              },
              sessions: makeSessions(),
            })
          );
          yield* Deferred.await(ready);
          endpoint.emit("stream", stream);
        })
      );

      expect(stream.reset).toHaveBeenCalledOnce();
      expect(stream.read).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
    })
  );

  it.live("resets inbound streams beyond the cap", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot;
      yield* Effect.tryPromise(() => chmod(root, 0o700));
      const endpoint = makeEndpoint();
      const ready = yield* Deferred.make<boolean>();
      const started = yield* Deferred.make<boolean>();
      const { out } = makeOut(ready);
      const hangSlot = yield* Deferred.make<Uint8Array>();
      const hang = () => {
        Effect.runSync(Deferred.succeed(started, true));
        return Effect.runPromise(Deferred.await(hangSlot));
      };
      const hanging = Array.from({ length: MAX_INBOUND_STREAMS }, () =>
        makeStream(CHAT_PROTOCOL, hang)
      );
      const extra = makeStream(CHAT_PROTOCOL);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const messages = yield* openCliOutboxStore(root);
          yield* Effect.forkChild(
            createHolder({
              endpoint,
              identity,
              lifecycle: makeLifecycle(),
              messages,
              out,
              reader: {
                lookupDeviceKey: () => Effect.succeed(account),
                lookupHandle: () => Effect.succeed(account),
              },
              sessions: makeSessions(),
            })
          );
          yield* Deferred.await(ready);
          for (const stream of hanging) {
            endpoint.emit("stream", stream);
          }
          yield* Deferred.await(started);
          endpoint.emit("stream", extra);
        })
      );

      expect(extra.reset).toHaveBeenCalledOnce();
      expect(extra.read).not.toHaveBeenCalled();
    })
  );

  it.live("interrupts inbound handlers before closing messages.db", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot;
      yield* Effect.tryPromise(() => chmod(root, 0o700));
      const endpoint = makeEndpoint();
      const ready = yield* Deferred.make<boolean>();
      const started = yield* Deferred.make<boolean>();
      const { out } = makeOut(ready);
      const hang = yield* Deferred.make<Uint8Array>();
      const stream = makeStream(CHAT_PROTOCOL, () => {
        Effect.runSync(Deferred.succeed(started, true));
        return Effect.runPromise(Deferred.await(hang));
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const messages = yield* openCliOutboxStore(root);
          yield* Effect.forkChild(
            createHolder({
              endpoint,
              identity,
              lifecycle: makeLifecycle(),
              messages,
              out,
              reader: {
                lookupDeviceKey: () => Effect.succeed(account),
                lookupHandle: () => Effect.succeed(account),
              },
              sessions: makeSessions(),
            })
          );
          yield* Deferred.await(ready);
          endpoint.emit("stream", stream);
          yield* Deferred.await(started);
        })
      );

      expect(stream.reset).toHaveBeenCalledOnce();
      expect(stream.write).not.toHaveBeenCalled();
      const inbox = yield* openCliOutboxStore(root).pipe(
        Effect.flatMap((messages) => messages.loadInbox())
      );
      expect(inbox).toEqual([]);
    })
  );

  it.live("delivers a sync handoff without waiting for a poll timer", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot;
      yield* Effect.tryPromise(() => chmod(root, 0o700));
      const aliceDeviceKey = yield* Schema.decodeUnknownEffect(PeerId)(
        PEER_BOB
      ).pipe(
        Effect.flatMap(deviceKeyFromPeerId),
        Effect.flatMap((deviceKey) => Schema.encodeEffect(Hex32)(deviceKey))
      );
      const carolDeviceKey = yield* Schema.decodeUnknownEffect(PeerId)(
        PEER_CAROL
      ).pipe(
        Effect.flatMap(deviceKeyFromPeerId),
        Effect.flatMap((deviceKey) => Schema.encodeEffect(Hex32)(deviceKey))
      );
      const aliceAccount: RegistryAccount = {
        blockNumber: 1n,
        deviceKey: aliceDeviceKey,
        devices: [{ deviceKey: aliceDeviceKey, peerId: PEER_BOB }],
        freshness: "fresh",
        handle: "alice",
        nonce: 0n,
        owner: "0x0000000000000000000000000000000000000001",
        ownerVersion: 0,
        peerId: PEER_BOB,
        qid: 1n,
        registeredAt: 1n,
      };
      const bobAccount: RegistryAccount = {
        ...aliceAccount,
        deviceKey: carolDeviceKey,
        devices: [{ deviceKey: carolDeviceKey, peerId: PEER_CAROL }],
        handle: "bob",
        peerId: PEER_CAROL,
        qid: 2n,
      };
      const lookupAccount = (key: string) => {
        if (key === aliceDeviceKey) {
          return Effect.succeed(aliceAccount);
        }
        if (key === carolDeviceKey) {
          return Effect.succeed(bobAccount);
        }
        return Effect.succeed(null);
      };
      const sessions = createPeerSessions({
        getContactByQid: () => Promise.resolve(null),
        lookupDeviceKey: lookupAccount,
        lookupHandle: (handle) =>
          Effect.succeed(handle === "bob" ? bobAccount : aliceAccount),
        ownQid: () => identity.qid,
        upsertContact: () => Promise.resolve(),
      });
      const endpoint = makeEndpoint();
      const ready = yield* Deferred.make<boolean>();
      const sent = yield* Deferred.make<boolean>();
      const { lines, out } = makeOut(ready);
      const originalLog = out.log;
      out.log = (line: string) => {
        originalLog(line);
        if (line.startsWith("Sent to @bob")) {
          Effect.runSync(Deferred.succeed(sent, true));
        }
      };
      const queued: OutboxRecordV1 = {
        attempts: 0,
        frame: {
          fromHandle: "alice",
          id: "c56a4180-65aa-42ec-a945-5fd21dec0538",
          sentAt: 1_700_000_000_000,
          text: "hello",
          v: 1,
        },
        lastError: null,
        nextAttemptAt: 1_700_000_000_000,
        queuedAt: 1_700_000_000_000,
        status: "queued",
        toHandle: "bob",
        toQid: "2",
        updatedAt: 1_700_000_000_000,
        v: 1,
      };
      const handoffBytes = yield* encodeSyncRequestV1({
        composedBy: aliceDeviceKey,
        record: queued,
        type: "handoff",
        v: 1,
      });
      const unread: (Uint8Array | undefined)[] = [handoffBytes, undefined];
      const syncStream = makeStream(SYNC_PROTOCOL, async () => {
        await Promise.resolve();
        return unread.shift();
      });
      const ackUnread = [encodeAck({ ack: queued.frame.id, v: 1 }), undefined];
      const bobStream = makeStream(CHAT_PROTOCOL, async () => {
        await Promise.resolve();
        return ackUnread.shift();
      });
      bobStream.connId = 4;
      bobStream.peerId = PEER_CAROL;
      endpoint.openStream.mockImplementation(
        (peerId: string, protocolId: string) => {
          expect(peerId).toBe(PEER_CAROL);
          expect(protocolId).toBe(CHAT_PROTOCOL);
          return Promise.resolve(bobStream);
        }
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const messages = yield* openCliOutboxStore(root);
          yield* Effect.forkChild(
            createHolder({
              endpoint,
              identity,
              lifecycle: makeLifecycle(),
              messages,
              out,
              reader: {
                lookupDeviceKey: lookupAccount,
                lookupHandle: (handle) =>
                  Effect.succeed(handle === "bob" ? bobAccount : aliceAccount),
              },
              sessions,
            })
          );
          yield* Deferred.await(ready);
          endpoint.emit("stream", syncStream);
          yield* Deferred.await(sent);
        })
      );

      expect(lines.some((line) => line.startsWith("Queued for @bob"))).toBe(
        true
      );
      expect(bobStream.write).toHaveBeenCalledOnce();
    })
  );
});
