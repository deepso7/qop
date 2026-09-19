import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { deviceKeyFromPeerId, Hex32, PeerId } from "@qop/identity";
import {
  createPeerSessions,
  encodeSyncRequestV1,
  encodeSyncResponseV1,
} from "@qop/protocol";
import type { OutboxRecordV1, RegistryAccount } from "@qop/protocol";
import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  CliOutboxStoreError,
  createCliOutboxStore,
} from "../src/outbox-store.ts";
import { handleInboundSyncStream } from "../src/sync.ts";
import type { CliSyncStore } from "../src/sync.ts";

const PEER_PHONE = "12D3KooWC7cDcNR4J3NC9y1gTkqafZKmnjCUvrRMxU2LMugGJGgy";
const id = "c56a4180-65aa-42ec-a945-5fd21dec0538";

const phoneDeviceKey = await Effect.runPromise(
  Schema.decodeUnknownEffect(PeerId)(PEER_PHONE).pipe(
    Effect.flatMap(deviceKeyFromPeerId),
    Effect.flatMap((deviceKey) => Schema.encodeEffect(Hex32)(deviceKey))
  )
);

const aliceAccount: RegistryAccount = {
  blockNumber: 1n,
  deviceKey: phoneDeviceKey,
  devices: [{ deviceKey: phoneDeviceKey, peerId: PEER_PHONE }],
  freshness: "fresh",
  handle: "alice",
  nonce: 0n,
  owner: "0x0000000000000000000000000000000000000001",
  ownerVersion: 0,
  peerId: PEER_PHONE,
  qid: 42n,
  registeredAt: 1n,
};

const queued: OutboxRecordV1 = {
  attempts: 0,
  frame: {
    fromHandle: "alice",
    id,
    sentAt: 1_700_000_000_000,
    text: "hello",
    v: 1,
  },
  lastError: null,
  nextAttemptAt: 1_700_000_000_000,
  queuedAt: 1_700_000_000_000,
  status: "queued",
  toHandle: "bob",
  toQid: "1",
  updatedAt: 1_700_000_000_000,
  v: 1,
};

const identity = { handle: "alice", qid: "42" };

const makeSessions = (account: RegistryAccount = aliceAccount) =>
  createPeerSessions({
    getContactByQid: () => Promise.resolve(null),
    lookupDeviceKey: () => Effect.succeed(account),
    lookupHandle: () => Effect.succeed(account),
    upsertContact: () => Promise.resolve(),
  });

const makeStream = (bytes: Uint8Array) => {
  const unread: (Uint8Array | undefined)[] = [bytes, undefined];
  return {
    closeWrite: vi.fn(),
    connId: 8,
    peerId: PEER_PHONE,
    read: vi.fn(async () => {
      await Promise.resolve();
      return unread.shift();
    }),
    reset: vi.fn(),
    write: vi.fn(),
  };
};

describe("CLI inbound sync", () => {
  it("preserves the stream receiver when writing and closing replies", async () => {
    const bytes = await Effect.runPromise(
      encodeSyncRequestV1({
        composedBy: phoneDeviceKey,
        record: queued,
        type: "handoff",
        v: 1,
      })
    );
    const replies: Uint8Array[] = [];
    const stream = {
      ...makeStream(bytes),
      closeWrite() {
        this.writeClosed = true;
      },
      replies,
      write(data: Uint8Array) {
        this.replies.push(data);
      },
      writeClosed: false,
    };
    await Effect.runPromise(
      handleInboundSyncStream(stream, makeSessions(), identity, {
        enqueue: () => Effect.succeed(queued),
        getByIds: () => Effect.succeed([]),
      })
    );
    expect(stream.replies).toEqual([
      await Effect.runPromise(encodeSyncResponseV1({ id, type: "held", v: 1 })),
    ]);
    expect(stream.writeClosed).toBe(true);
  });

  it("replies held only after a durable enqueue", async () => {
    const order: string[] = [];
    const enqueue = vi.fn(() =>
      Effect.sync(() => {
        order.push("enqueue");
        return queued;
      })
    );
    const store: CliSyncStore = {
      enqueue,
      getByIds: () => Effect.succeed([]),
    };
    const stream = makeStream(
      await Effect.runPromise(
        encodeSyncRequestV1({
          composedBy: phoneDeviceKey,
          record: queued,
          type: "handoff",
          v: 1,
        })
      )
    );
    stream.write.mockImplementation(() => {
      order.push("held");
    });
    const response = await Effect.runPromise(
      handleInboundSyncStream(stream, makeSessions(), identity, store)
    );
    expect(response).toEqual({ id, type: "held", v: 1 });
    expect(order).toEqual(["enqueue", "held"]);
    expect(enqueue).toHaveBeenCalledWith(queued);
    expect(stream.closeWrite).toHaveBeenCalledOnce();
    expect(stream.reset).not.toHaveBeenCalled();
  });

  it("does not reply held when persist fails", async () => {
    const store: CliSyncStore = {
      enqueue: () =>
        Effect.fail(new CliOutboxStoreError({ operation: "write" })),
      getByIds: () => Effect.succeed([]),
    };
    const stream = makeStream(
      await Effect.runPromise(
        encodeSyncRequestV1({
          composedBy: phoneDeviceKey,
          record: queued,
          type: "handoff",
          v: 1,
        })
      )
    );
    const result = await Effect.runPromise(
      handleInboundSyncStream(stream, makeSessions(), identity, store).pipe(
        Effect.result
      )
    );
    expect(result._tag).toBe("Failure");
    expect(stream.write).not.toHaveBeenCalled();
  });

  it("replies conflict without enqueueing different content under the same id", async () => {
    const store: CliSyncStore = {
      enqueue: () =>
        Effect.fail(new CliOutboxStoreError({ operation: "conflict" })),
      getByIds: () => Effect.succeed([]),
    };
    const stream = makeStream(
      await Effect.runPromise(
        encodeSyncRequestV1({
          composedBy: phoneDeviceKey,
          record: queued,
          type: "handoff",
          v: 1,
        })
      )
    );
    const response = await Effect.runPromise(
      handleInboundSyncStream(stream, makeSessions(), identity, store)
    );
    expect(response).toEqual({ reason: "conflict", type: "error", v: 1 });
    expect(stream.write).toHaveBeenCalledWith(
      await Effect.runPromise(
        encodeSyncResponseV1({ reason: "conflict", type: "error", v: 1 })
      )
    );
  });

  it("returns receipts for sent ids and omits still-queued ones", async () => {
    const store: CliSyncStore = {
      enqueue: () => Effect.succeed(queued),
      getByIds: () =>
        Effect.succeed([
          queued,
          { ...queued, status: "sent" as const, updatedAt: 9 },
        ]),
    };
    const stream = makeStream(
      await Effect.runPromise(
        encodeSyncRequestV1({ ids: [id], type: "poll", v: 1 })
      )
    );
    const response = await Effect.runPromise(
      handleInboundSyncStream(stream, makeSessions(), identity, store)
    );
    expect(response).toEqual({
      receipts: [{ deliveredAt: 9, id, toQid: "1" }],
      type: "receipts",
      v: 1,
    });
  });

  it("rejects a handoff whose composer is not the connected peer", async () => {
    const enqueue = vi.fn(() => Effect.succeed(queued));
    const store: CliSyncStore = {
      enqueue,
      getByIds: () => Effect.succeed([]),
    };
    const stream = makeStream(
      await Effect.runPromise(
        encodeSyncRequestV1({
          composedBy: `0x${"aa".repeat(32)}`,
          record: queued,
          type: "handoff",
          v: 1,
        })
      )
    );
    const response = await Effect.runPromise(
      handleInboundSyncStream(stream, makeSessions(), identity, store)
    );
    expect(response).toEqual({ reason: "invalid", type: "error", v: 1 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not persist a handoff when auth is invalidated during read", async () => {
    const enqueue = vi.fn(() => Effect.succeed(queued));
    const store: CliSyncStore = {
      enqueue,
      getByIds: () => Effect.succeed([]),
    };
    const sessions = makeSessions();
    const bytes = await Effect.runPromise(
      encodeSyncRequestV1({
        composedBy: phoneDeviceKey,
        record: queued,
        type: "handoff",
        v: 1,
      })
    );
    const unread: (Uint8Array | undefined)[] = [bytes, undefined];
    const stream = makeStream(bytes);
    stream.read.mockImplementation(() => {
      sessions.invalidateAuthorization();
      return Promise.resolve(unread.shift());
    });
    const result = await Effect.runPromise(
      handleInboundSyncStream(stream, sessions, identity, store).pipe(
        Effect.result
      )
    );
    expect(result._tag).toBe("Failure");
    expect(enqueue).not.toHaveBeenCalled();
    expect(stream.write).not.toHaveBeenCalled();
    expect(stream.reset).toHaveBeenCalledOnce();
  });

  it("does not persist a handoff when live-auth is revoked after read", async () => {
    const enqueue = vi.fn(() => Effect.succeed(queued));
    const store: CliSyncStore = {
      enqueue,
      getByIds: () => Effect.succeed([]),
    };
    const stream = makeStream(
      await Effect.runPromise(
        encodeSyncRequestV1({
          composedBy: phoneDeviceKey,
          record: queued,
          type: "handoff",
          v: 1,
        })
      )
    );
    const result = await Effect.runPromise(
      handleInboundSyncStream(
        stream,
        makeSessions(),
        identity,
        store,
        () => false
      ).pipe(Effect.result)
    );
    expect(result._tag).toBe("Failure");
    expect(enqueue).not.toHaveBeenCalled();
    expect(stream.write).not.toHaveBeenCalled();
    expect(stream.reset).toHaveBeenCalledOnce();
  });

  it("replies invalid instead of held for an existing failed record", async () => {
    const enqueue = vi.fn(() =>
      Effect.succeed({ ...queued, status: "failed" as const })
    );
    const store: CliSyncStore = {
      enqueue,
      getByIds: () => Effect.succeed([]),
    };
    const stream = makeStream(
      await Effect.runPromise(
        encodeSyncRequestV1({
          composedBy: phoneDeviceKey,
          record: queued,
          type: "handoff",
          v: 1,
        })
      )
    );
    const response = await Effect.runPromise(
      handleInboundSyncStream(stream, makeSessions(), identity, store)
    );
    expect(response).toEqual({ reason: "invalid", type: "error", v: 1 });
    expect(enqueue).toHaveBeenCalledWith(queued);
  });

  it("keeps the original disk record when a conflicting handoff is rejected", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qop-sync-conflict-"));
    try {
      await chmod(root, 0o700);
      const store = createCliOutboxStore(root);
      await Effect.runPromise(store.enqueue(queued));
      const stream = makeStream(
        await Effect.runPromise(
          encodeSyncRequestV1({
            composedBy: phoneDeviceKey,
            record: {
              ...queued,
              frame: { ...queued.frame, text: "other" },
            },
            type: "handoff",
            v: 1,
          })
        )
      );
      const response = await Effect.runPromise(
        handleInboundSyncStream(stream, makeSessions(), identity, store)
      );
      expect(response).toEqual({ reason: "conflict", type: "error", v: 1 });
      expect(await Effect.runPromise(store.getByIds([id]))).toEqual([queued]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
