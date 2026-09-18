import { deviceKeyFromPeerId, Hex32, PeerId } from "@qop/identity";
import {
  decodeSyncRequestV1,
  encodeSyncResponseV1,
  SYNC_POLL_MAX_IDS,
  SYNC_PROTOCOL,
} from "@qop/protocol";
import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  deleteAll,
  getContactByQid,
  listConversations,
  upsertContact,
} from "@/lib/db";
import { createPeerSessions } from "@/lib/p2p-sessions";
import { chunkSyncPollIds, performHandoff, performPoll } from "@/lib/p2p-sync";
import type { RegistryAccount, RegistryReaderError } from "@/lib/registry-core";

const PEER_CLI = "12D3KooWDGEF3VLEM7R3XWGJsqPCcSSjwRmuNw6JTQMVMNSSzwAz";
const id = "c56a4180-65aa-42ec-a945-5fd21dec0538";

const cliDeviceKey = await Effect.runPromise(
  Schema.decodeUnknownEffect(PeerId)(PEER_CLI).pipe(
    Effect.flatMap(deviceKeyFromPeerId),
    Effect.flatMap((deviceKey) => Schema.encodeEffect(Hex32)(deviceKey))
  )
);

const own = {
  deviceKey: `0x${"aa".repeat(32)}`,
  handle: "alice",
  peerId: "12D3KooWC7cDcNR4J3NC9y1gTkqafZKmnjCUvrRMxU2LMugGJGgy",
  qid: "42",
};
const record = {
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

const aliceAccount: RegistryAccount = {
  blockNumber: 1n,
  deviceKey: own.deviceKey,
  devices: [
    { deviceKey: own.deviceKey, peerId: own.peerId },
    { deviceKey: cliDeviceKey, peerId: PEER_CLI },
  ],
  freshness: "fresh",
  handle: "alice",
  nonce: 0n,
  owner: "0x0000000000000000000000000000000000000001",
  ownerVersion: 0,
  peerId: own.peerId,
  qid: 42n,
  registeredAt: 1n,
};

const makeEndpoint = (read: () => Promise<Uint8Array | undefined>) => {
  const lookupDeviceKey = vi.fn(
    (): Effect.Effect<RegistryAccount | null, RegistryReaderError> =>
      Effect.succeed(aliceAccount)
  );
  const lookupHandle = vi.fn(
    (): Effect.Effect<RegistryAccount | null, RegistryReaderError> =>
      Effect.succeed(aliceAccount)
  );
  const sessions = createPeerSessions({
    getContactByQid: () => Promise.resolve(null),
    lookupDeviceKey,
    lookupHandle,
    upsertContact: () => Promise.resolve(),
  });
  const stream = {
    closeWrite: vi.fn(),
    connId: 4,
    peerId: PEER_CLI,
    read: vi.fn(read),
    reset: vi.fn(),
    write: vi.fn(),
  };
  const endpoint = {
    connect: vi.fn().mockResolvedValue({}),
    connectedPeers: vi.fn((): string[] => []),
    openStream: vi.fn().mockResolvedValue(stream),
    waitPeerReady: vi.fn(() => Promise.resolve({ peerId: PEER_CLI })),
  };
  return { endpoint, sessions, stream };
};

const responseReader = (bytes: Uint8Array) => {
  const chunks: (Uint8Array | undefined)[] = [bytes, undefined];
  return () => Promise.resolve(chunks.shift());
};

const encodeReceipts = (chunk: readonly string[]) =>
  Effect.runPromise(
    encodeSyncResponseV1({
      receipts: chunk.map((receiptId) => ({
        deliveredAt: 9,
        id: receiptId,
      })),
      type: "receipts",
      v: 1,
    })
  );

describe("performHandoff", () => {
  it("writes a handoff on /qop/sync/1 and accepts held", async () => {
    const held = await Effect.runPromise(
      encodeSyncResponseV1({ id, type: "held", v: 1 })
    );
    const { endpoint, sessions, stream } = makeEndpoint(responseReader(held));

    await expect(
      performHandoff({
        composedBy: own.deviceKey,
        endpoint,
        holderPeerId: PEER_CLI,
        own,
        record,
        sessions,
        timeoutMs: 50,
      })
    ).resolves.toBeUndefined();

    expect(endpoint.openStream).toHaveBeenCalledWith(PEER_CLI, SYNC_PROTOCOL, {
      timeoutMs: 50,
    });
    expect(stream.write).toHaveBeenCalledOnce();
    expect(stream.closeWrite).toHaveBeenCalledOnce();
    expect(stream.reset).not.toHaveBeenCalled();
  });

  it("does not insert own identity into chats when verifying the CLI", async () => {
    await deleteAll();
    const held = await Effect.runPromise(
      encodeSyncResponseV1({ id, type: "held", v: 1 })
    );
    const lookupDeviceKey = vi.fn(
      (): Effect.Effect<RegistryAccount | null, RegistryReaderError> =>
        Effect.succeed(aliceAccount)
    );
    const lookupHandle = vi.fn(
      (): Effect.Effect<RegistryAccount | null, RegistryReaderError> =>
        Effect.succeed(aliceAccount)
    );
    const sessions = createPeerSessions({
      getContactByQid,
      lookupDeviceKey,
      lookupHandle,
      ownQid: () => own.qid,
      upsertContact,
    });
    const chunks: (Uint8Array | undefined)[] = [held, undefined];
    const stream = {
      closeWrite: vi.fn(),
      connId: 4,
      peerId: PEER_CLI,
      read: vi.fn(() => Promise.resolve(chunks.shift())),
      reset: vi.fn(),
      write: vi.fn(),
    };
    const endpoint = {
      connect: vi.fn().mockResolvedValue({}),
      connectedPeers: vi.fn((): string[] => []),
      openStream: vi.fn().mockResolvedValue(stream),
      waitPeerReady: vi.fn(() => Promise.resolve({ peerId: PEER_CLI })),
    };

    await performHandoff({
      composedBy: own.deviceKey,
      endpoint,
      holderPeerId: PEER_CLI,
      own,
      record,
      sessions,
      timeoutMs: 50,
    });

    expect(await getContactByQid(own.qid)).toBeNull();
    expect(await listConversations()).toEqual([]);
  });
});

describe("performPoll", () => {
  it("returns receipts from the CLI", async () => {
    const encoded = await Effect.runPromise(
      encodeSyncResponseV1({
        receipts: [{ deliveredAt: 9, id }],
        type: "receipts",
        v: 1,
      })
    );
    const { endpoint, sessions } = makeEndpoint(responseReader(encoded));
    await expect(
      performPoll({
        endpoint,
        holderPeerId: PEER_CLI,
        ids: [id],
        own,
        sessions,
        timeoutMs: 50,
      })
    ).resolves.toEqual([{ deliveredAt: 9, id }]);
  });

  it("chunks ids so later held messages are still polled", async () => {
    expect(chunkSyncPollIds([]).length).toBe(0);
    const ids = Array.from(
      { length: SYNC_POLL_MAX_IDS + 1 },
      (_, index) =>
        `c56a4180-65aa-42ec-a945-5fd21dec${index.toString(16).padStart(4, "0")}`
    );
    expect(chunkSyncPollIds(ids).map((chunk) => chunk.length)).toEqual([
      SYNC_POLL_MAX_IDS,
      1,
    ]);
    expect(chunkSyncPollIds(ids)[1]).toEqual([ids[SYNC_POLL_MAX_IDS]]);

    const first = await encodeReceipts(ids.slice(0, SYNC_POLL_MAX_IDS));
    const lastId = ids[SYNC_POLL_MAX_IDS];
    if (!lastId) {
      throw new Error("expected a 33rd poll id");
    }
    const second = await encodeReceipts([lastId]);
    const streams = [first, second].map((bytes, index) => {
      const chunks: (Uint8Array | undefined)[] = [bytes, undefined];
      return {
        closeWrite: vi.fn(),
        connId: 4 + index,
        peerId: PEER_CLI,
        read: vi.fn(() => Promise.resolve(chunks.shift())),
        reset: vi.fn(),
        write: vi.fn(),
      };
    });
    let opened = 0;
    const lookupDeviceKey = vi.fn(() => Effect.succeed(aliceAccount));
    const lookupHandle = vi.fn(() => Effect.succeed(aliceAccount));
    const sessions = createPeerSessions({
      getContactByQid: () => Promise.resolve(null),
      lookupDeviceKey,
      lookupHandle,
      upsertContact: () => Promise.resolve(),
    });
    const endpoint = {
      connect: vi.fn().mockResolvedValue({}),
      connectedPeers: vi.fn((): string[] => []),
      openStream: vi.fn(() => {
        const stream = streams[opened];
        opened += 1;
        if (!stream) {
          throw new Error("unexpected extra poll stream");
        }
        return Promise.resolve(stream);
      }),
      waitPeerReady: vi.fn(() => Promise.resolve({ peerId: PEER_CLI })),
    };

    await expect(
      performPoll({
        endpoint,
        holderPeerId: PEER_CLI,
        ids,
        own,
        sessions,
        timeoutMs: 50,
      })
    ).resolves.toEqual(
      ids.map((receiptId) => ({ deliveredAt: 9, id: receiptId }))
    );

    expect(endpoint.openStream).toHaveBeenCalledTimes(2);
    const written = await Promise.all(
      streams.map((stream) => {
        const bytes = stream.write.mock.calls[0]?.[0];
        if (!(bytes instanceof Uint8Array)) {
          throw new Error("expected a poll frame");
        }
        return Effect.runPromise(decodeSyncRequestV1(bytes));
      })
    );
    expect(written).toEqual([
      { ids: ids.slice(0, SYNC_POLL_MAX_IDS), type: "poll", v: 1 },
      { ids: [lastId], type: "poll", v: 1 },
    ]);
  });
});
