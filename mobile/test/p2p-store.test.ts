import { setTimeout as sleep } from "node:timers/promises";

import { deviceKeyBytesFromPeerId } from "@qop/identity";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CHAT_PROTOCOL, createChatCipher, encodeAck } from "@/lib/chat-wire";
import {
  advanceMessageStatus,
  deleteAll,
  getContactByQid,
  getMessageById,
  insertMessage,
  listMessages,
  queueMessageRetry,
  upsertContact,
} from "@/lib/db";
import { createMobileOutbox } from "@/lib/mobile-outbox";
import type { performSend } from "@/lib/p2p-send";
import { performSend as sendToPeer } from "@/lib/p2p-send";
import { createP2pStore } from "@/lib/p2p-store-core";
import type { P2pEndpoint } from "@/lib/p2p-store-core";
import type {
  lookupDeviceKey as LookupDeviceKey,
  lookupHandle as LookupHandle,
} from "@/lib/registry";
import type { RegistryAccount } from "@/lib/registry-core";

import { failNextRun, pauseNextRun } from "./support/sqlite";

let deliverySignal: AbortSignal | undefined;

const PEER_BOB = "12D3KooWK99VoVxNE7XzyBwXEzW7xhK7Gpv85r9F3V3fyKSUKPH5";
const PEER_ALICE = "12D3KooWDpJ7As7BWAwRMfu1VU2WCqNjvq387JEYKDBj4kx6nXTN";
const bob = createChatCipher(new Uint8Array(32).fill(1));

const bobDeviceKey =
  "0x8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c";

const bobAccount: RegistryAccount = {
  blockNumber: 1n,
  deviceKey: bobDeviceKey,
  devices: [
    {
      deviceKey: bobDeviceKey,
      peerId: PEER_BOB,
    },
  ],
  freshness: "fresh",
  handle: "bob",
  nonce: 0n,
  owner: "0x0000000000000000000000000000000000000001",
  ownerVersion: 0,
  peerId: PEER_BOB,
  qid: 1n,
  registeredAt: 1n,
};

interface Connection {
  readonly connId: number;
  readonly peerId: string;
}

type InboundStream = Connection & {
  readonly closeWrite: ReturnType<typeof vi.fn>;
  readonly protocolId: string;
  read: () => Promise<Uint8Array | undefined>;
  readonly reset: ReturnType<typeof vi.fn>;
  readonly write: ReturnType<typeof vi.fn>;
};

let closed: Parameters<P2pEndpoint["onClose"]>[0] | undefined;

const closeReport = {
  outcome: "Drained",
  reason: "close",
  unfinished: [],
} as const;

let driverFailed: ((event: { detail: string }) => void) | undefined;
let connectionEstablished: ((connection: Connection) => void) | undefined;
let onStream: ((stream: InboundStream) => void) | undefined;
let queueOverflow: (() => void) | undefined;
let pathUpgraded: (() => void) | undefined;
const disconnect = vi.fn();
const connectedPeers = vi.fn((): string[] => [PEER_BOB]);
const path = vi.fn<P2pEndpoint["path"]>();
const isPeerReady = vi.fn<P2pEndpoint["isPeerReady"]>();
const connect = vi.fn<P2pEndpoint["connect"]>();
const waitPeerReady = vi.fn<P2pEndpoint["waitPeerReady"]>();
const send = vi.fn<typeof performSend>();

const lookupDeviceKey = vi.fn((): ReturnType<typeof LookupDeviceKey> =>
  Effect.succeed(bobAccount)
);

const lookupHandle = vi.fn<typeof LookupHandle>(() =>
  Effect.succeed(bobAccount)
);

type EventListener = (event: never) => void;

const captureEndpointEvent: P2pEndpoint["on"] = (
  typeOrHandler: string | EventListener,
  maybeHandler?: EventListener
) => {
  if (!maybeHandler) {
    return () => {};
  }

  if (typeOrHandler === "driverFailed") {
    // SAFETY: This branch only runs for the driverFailed registration.
    driverFailed = maybeHandler as (event: { detail: string }) => void;

    return () => {
      driverFailed = undefined;
    };
  }

  if (typeOrHandler === "connectionEstablished") {
    // SAFETY: This branch only runs for the connectionEstablished registration.
    connectionEstablished = maybeHandler as (connection: Connection) => void;

    return () => {
      connectionEstablished = undefined;
    };
  }

  if (typeOrHandler === "stream") {
    // SAFETY: This branch only runs for the stream registration.
    onStream = maybeHandler as (event: InboundStream) => void;

    return () => {
      onStream = undefined;
    };
  }

  if (typeOrHandler === "pathUpgraded") {
    // SAFETY: The store's path handlers re-read paths and ignore the payload.
    pathUpgraded = maybeHandler as () => void;

    return () => {
      pathUpgraded = undefined;
    };
  }

  if (typeOrHandler === "queueOverflow") {
    // SAFETY: The store's queue-overflow handler discards the payload.
    queueOverflow = () =>
      (maybeHandler as (event: { readonly dropped: number }) => void)({
        dropped: 1,
      });

    return () => {
      queueOverflow = undefined;
    };
  }

  return () => {};
};

let appResumeHandler: (() => void) | undefined;

const useP2pStore = createP2pStore({
  createOutbox: (dependencies) =>
    createMobileOutbox({
      ...dependencies,
      deliver: (message, signal) =>
        dependencies.deliver(message, deliverySignal ?? signal),
    }),
  createEndpoint: () => ({
    bindAppState: () => () => {},
    endpoint: {
      activeReservation: () => {},
      close: () => Promise.resolve(closeReport),
      connect,
      connectedPeers,
      disconnect,
      isPeerReady,
      on: captureEndpointEvent,
      onClose: (callback) => {
        closed = callback;

        return () => {
          closed = undefined;
        };
      },
      openStream: () =>
        Promise.reject(new Error("No stream in lifecycle fixture")),
      path,
      waitPeerReady,
    },
  }),
  getIdentityHandle: () => "alice",
  loadDeviceSecretKey: () => Effect.succeed(new Uint8Array(32)),
  lookupDeviceKey,
  lookupHandle,
  performSend: send,
  randomUUID: () => crypto.randomUUID(),
  subscribeAppResume: (onResume) => {
    appResumeHandler = onResume;

    return () => {
      appResumeHandler = undefined;
    };
  },
});

beforeEach(async () => {
  deliverySignal = undefined;
  vi.stubEnv("EXPO_PUBLIC_RELAY_ADDRS", "/test-relay");
  send.mockReset().mockResolvedValue();
  lookupDeviceKey.mockReset().mockReturnValue(Effect.succeed(bobAccount));
  lookupHandle.mockReset().mockReturnValue(Effect.succeed(bobAccount));
  disconnect.mockReset();
  connectedPeers.mockReset().mockReturnValue([PEER_BOB]);
  path.mockReset();
  isPeerReady.mockReset().mockReturnValue(true);
  connect
    .mockReset()
    .mockRejectedValue(new Error("No dial in lifecycle fixture"));
  waitPeerReady
    .mockReset()
    .mockRejectedValue(new Error("No pairing wait in lifecycle fixture"));
  closed = undefined;
  driverFailed = undefined;
  connectionEstablished = undefined;
  onStream = undefined;
  queueOverflow = undefined;
  pathUpgraded = undefined;
  await deleteAll();
  await upsertContact({
    createdAt: 1,
    deviceKey: bobDeviceKey,
    handle: "bob",
    owner: bobAccount.owner,
    peerId: PEER_BOB,
    qid: "1",
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await useP2pStore.getState().stop();
  vi.unstubAllEnvs();
});

const beginSend = async () => {
  await useP2pStore.getState().start();
  const contact = await getContactByQid("1");

  if (!contact) {
    throw new Error("Missing contact fixture");
  }

  const pending = Promise.withResolvers<undefined>();
  send.mockReturnValueOnce(pending.promise);
  const id = useP2pStore.getState().sendMessage(contact, "hello");
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());

  return { id, pending };
};

const runningConnection = () => {
  const { connection } = useP2pStore.getState();

  if (connection.status !== "running") {
    throw new Error(`Expected running P2P, got ${connection.status}`);
  }

  return connection;
};

const inboundFrame = (id: string) =>
  bob.seal(
    { fromHandle: "bob", id, sentAt: 1, text: "hello inbound", v: 1 },
    deviceKeyBytesFromPeerId(PEER_ALICE)
  );

const makeInboundStream = (
  bytes: Uint8Array,
  peerId = PEER_BOB
): InboundStream => {
  const chunks: (Uint8Array | undefined)[] = [bytes, undefined];

  return {
    closeWrite: vi.fn(),
    connId: 7,
    peerId,
    protocolId: CHAT_PROTOCOL,
    read: () => Promise.resolve(chunks.shift()),
    reset: vi.fn(),
    write: vi.fn(async () => {}),
  };
};

// Promise.resolve(undefined) without tripping unicorn/no-useless-undefined.
const resolvedUndefined = async (): Promise<undefined> => {
  await Promise.resolve();
};

describe("automatic outbox", () => {
  it("wakes a connected contact after unrelated roster failures", async () => {
    const backoff = async (
      id: string,
      qid: string,
      attempts: number
    ): Promise<void> => {
      await queueMessageRetry(id, qid);

      if (attempts > 1) {
        await advanceMessageStatus(id, "sending", qid);
        await backoff(id, qid, attempts - 1);
      }
    };

    const seed = async (qid: string) => {
      if (qid !== "1") {
        await upsertContact({
          createdAt: 1,
          deviceKey: bobAccount.deviceKey ?? "",
          handle: `contact${qid}`,
          owner: bobAccount.owner,
          peerId: PEER_BOB,
          qid,
        });
      }

      const id = `queued-${qid}`;
      await insertMessage({
        id,
        contactQid: qid,
        direction: "out",
        status: "sending",
        text: "waiting",
        sentAt: 1,
      });

      await backoff(id, qid, 6);
    };

    await Promise.all(["2", "3", "4", "5", "6", "7", "8", "9"].map(seed));
    await seed("1");

    lookupHandle.mockImplementation((handle) =>
      Effect.succeed(handle === "bob" ? bobAccount : null)
    );
    await useP2pStore.getState().start();
    connectionEstablished?.({ connId: 7, peerId: PEER_BOB });
    await vi.waitFor(async () =>
      expect(await getMessageById("queued-1", "1")).toMatchObject({
        status: "sent",
      })
    );
    expect(send).toHaveBeenCalledOnce();
  });
  it("requeues a delivery aborted while its sending claim is pending", async () => {
    const controller = new AbortController();
    deliverySignal = controller.signal;
    const id = crypto.randomUUID();
    await insertMessage({
      id,
      contactQid: "1",
      direction: "out",
      status: "queued",
      text: "abort after claim",
      sentAt: 1,
    });

    const claim = pauseNextRun((sql) =>
      sql.includes("UPDATE messages SET status = ?")
    );

    try {
      await useP2pStore.getState().start();
      await claim.started;
      controller.abort();
      claim.resume();
      await vi.waitFor(async () =>
        expect(await getMessageById(id)).toMatchObject({
          status: "queued",
          attempts: 1,
        })
      );
      expect(send).not.toHaveBeenCalled();
    } finally {
      claim.resume();
    }
  });
  it("delivers after failure when an authorized peer comes online without manual retry", async () => {
    send.mockRejectedValue(new Error("recipient offline"));
    await useP2pStore.getState().start();
    const contact = await getContactByQid("1");

    if (!contact) {
      throw new Error("Missing contact");
    }

    const id = useP2pStore.getState().sendMessage(contact, "queued hello");
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({
        status: "queued",
        attempts: 1,
      })
    );
    const queued = await getMessageById(id);
    send.mockResolvedValue();
    connectionEstablished?.({ connId: 7, peerId: PEER_BOB });
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({
        status: "sent",
        text: "queued hello",
      })
    );
    expect(Date.now()).toBeLessThan(queued?.nextAttemptAt ?? 0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([input]) => input.frame.id)).toEqual([id, id]);
  });

  it("resumes persisted retries after endpoint restart", async () => {
    send.mockRejectedValue(new Error("offline"));
    await useP2pStore.getState().start();
    const contact = await getContactByQid("1");

    if (!contact) {
      throw new Error("Missing contact");
    }

    const id = useP2pStore.getState().sendMessage(contact, "survives restart");
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await useP2pStore.getState().stop();
    send.mockResolvedValue();
    await useP2pStore.getState().start();
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(2100);
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({ status: "sent" })
    );
    expect(send.mock.calls.map(([input]) => input.frame.id)).toEqual([id, id]);
  });

  it("keeps terminal handle reassignment failed and does not send to its new owner", async () => {
    send.mockImplementation(sendToPeer);
    lookupHandle.mockReturnValue(Effect.succeed({ ...bobAccount, qid: 99n }));
    await useP2pStore.getState().start();
    const contact = await getContactByQid("1");

    if (!contact) {
      throw new Error("Missing contact");
    }

    const id = useP2pStore
      .getState()
      .sendMessage(contact, "not for the new owner");

    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({ status: "failed" })
    );
    appResumeHandler?.();
    await sleep(20);
    expect(await getMessageById(id)).toMatchObject({ status: "failed" });
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("interrupted sends", () => {
  it("recovers a persisted send before starting a new endpoint", async () => {
    await insertMessage({
      contactQid: "1",
      direction: "out",
      id: "c56a4180-65aa-42ec-a945-5fd21dec0572",
      sentAt: 1,
      status: "sending",
      text: "hello",
    });
    await useP2pStore.getState().start();
    await vi.waitFor(async () =>
      expect(
        await getMessageById("c56a4180-65aa-42ec-a945-5fd21dec0572")
      ).toMatchObject({ status: "sent" })
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it("makes an endpoint-interrupted send retryable with its original ID", async () => {
    const { id, pending } = await beginSend();
    closed?.(closeReport);
    pending.reject(new Error("connection closed"));
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({ status: "queued" })
    );
    await useP2pStore.getState().start();
    await useP2pStore.getState().retryMessage(id);
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({
        id,
        status: "sent",
        text: "hello",
      })
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ frame: expect.objectContaining({ id }) })
    );
  });

  it("recovers an interrupted send before stop finishes", async () => {
    const { id, pending } = await beginSend();
    const stopped = useP2pStore.getState().stop();
    pending.reject(new Error("connection closed"));
    await stopped;
    expect(await getMessageById(id)).toMatchObject({ status: "queued" });
  });

  it("tears down and recovers interrupted sends on driverFailed", async () => {
    const { id, pending } = await beginSend();
    expect(useP2pStore.getState().connection.status).toBe("running");
    driverFailed?.({ detail: "native panic" });
    pending.reject(new Error("driver failed"));
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({ status: "queued" })
    );
    expect(useP2pStore.getState().connection).toEqual({
      reason: "native panic",
      status: "failed",
    });
  });

  it("keeps the failure reason when send recovery hits a storage error", async () => {
    const { pending } = await beginSend();

    // Fail the recovery's failInterruptedMessages write.
    const recoveryFailed = failNextRun((sql) =>
      sql.includes("WHERE direction = 'out' AND status = 'sending'")
    );

    driverFailed?.({ detail: "native panic" });
    pending.reject(new Error("driver failed"));
    await recoveryFailed;
    // Let the recovery's catch run before asserting.
    await sleep(0);
    expect(useP2pStore.getState().connection).toEqual({
      reason: "native panic",
      status: "failed",
    });
  });

  it("restarts from failed before retrying a message", async () => {
    const { id, pending } = await beginSend();
    closed?.(closeReport);
    pending.reject(new Error("connection closed"));
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({ status: "queued" })
    );
    expect(useP2pStore.getState().connection.status).toBe("failed");
    // retryMessage should call start itself — no prior start() from the test.
    await useP2pStore.getState().retryMessage(id);
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({
        id,
        status: "sent",
        text: "hello",
      })
    );
    expect(useP2pStore.getState().connection.status).toBe("running");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent retries for the same message", async () => {
    const { id, pending } = await beginSend();
    closed?.(closeReport);
    pending.reject(new Error("connection closed"));
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({ status: "queued" })
    );
    await useP2pStore.getState().start();
    const retryPending = Promise.withResolvers<undefined>();
    send.mockReturnValueOnce(retryPending.promise);

    const first = useP2pStore.getState().retryMessage(id);
    const second = useP2pStore.getState().retryMessage(id);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    retryPending.resolve(await resolvedUndefined());
    await Promise.all([first, second]);

    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({ status: "sent" })
    );
  });

  it("retries after a capped stop cancels an abandoned retry", async () => {
    const { id, pending } = await beginSend();
    closed?.(closeReport);
    pending.reject(new Error("connection closed"));
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({ status: "queued" })
    );
    await useP2pStore.getState().start();

    const abandoned = Promise.withResolvers<undefined>();
    let cancelled = false;
    send.mockImplementationOnce(({ signal }) => {
      signal?.addEventListener("abort", () => {
        cancelled = true;
      });

      return abandoned.promise;
    });
    const oldRetry = useP2pStore.getState().retryMessage(id);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));

    vi.useFakeTimers();

    try {
      const stopped = useP2pStore.getState().stop();
      await vi.advanceTimersByTimeAsync(5000);
      await stopped;
      expect(cancelled).toBe(true);
      expect(await getMessageById(id)).toMatchObject({ status: "queued" });

      const freshRetry = useP2pStore.getState().retryMessage(id);
      await vi.advanceTimersByTimeAsync(5000);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
      await freshRetry;
      await vi.waitFor(async () =>
        expect(await getMessageById(id)).toMatchObject({ status: "sent" })
      );

      abandoned.resolve(await resolvedUndefined());
      await oldRetry;
      await vi.waitFor(async () =>
        expect(await getMessageById(id)).toMatchObject({ status: "sent" })
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("inbound chat streams", () => {
  const messageId = "c56a4180-65aa-42ec-a945-5fd21dec0538";

  it("acks freshly sealed retries of the same id but stores one message", async () => {
    await useP2pStore.getState().start();
    const firstEnvelope = await inboundFrame(messageId);
    const retryEnvelope = await inboundFrame(messageId);
    expect(retryEnvelope).not.toEqual(firstEnvelope);

    const receive = async (envelope: Uint8Array) => {
      const stream = makeInboundStream(envelope);
      onStream?.(stream);
      await vi.waitFor(() => expect(stream.closeWrite).toHaveBeenCalledOnce());
      expect(stream.write).toHaveBeenCalledWith(
        encodeAck({ ack: messageId, v: 1 })
      );
      expect(stream.reset).not.toHaveBeenCalled();
    };

    await receive(firstEnvelope);
    await receive(retryEnvelope);

    expect(await listMessages("1")).toEqual([
      expect.objectContaining({
        direction: "in",
        id: messageId,
        status: "received",
        text: "hello inbound",
      }),
    ]);
  });

  it("acks a verified inbound frame and stores it", async () => {
    await useP2pStore.getState().start();
    connectionEstablished?.({ connId: 7, peerId: PEER_BOB });
    const stream = makeInboundStream(await inboundFrame(messageId));
    onStream?.(stream);
    await vi.waitFor(async () =>
      expect(await getMessageById(messageId)).toMatchObject({
        contactQid: "1",
        direction: "in",
        status: "received",
        text: "hello inbound",
      })
    );
    expect(stream.write).toHaveBeenCalledWith(
      encodeAck({ ack: messageId, v: 1 })
    );
    expect(stream.closeWrite).toHaveBeenCalledOnce();
    expect(stream.reset).not.toHaveBeenCalled();
  });

  it("acks an inbound frame even if connectionEstablished was missed", async () => {
    await useP2pStore.getState().start();
    const stream = makeInboundStream(await inboundFrame(messageId));
    onStream?.(stream);
    await vi.waitFor(async () =>
      expect(await getMessageById(messageId)).toMatchObject({
        contactQid: "1",
        direction: "in",
        status: "received",
        text: "hello inbound",
      })
    );
    expect(stream.write).toHaveBeenCalledWith(
      encodeAck({ ack: messageId, v: 1 })
    );
    expect(stream.reset).not.toHaveBeenCalled();
  });

  it("invalidates authorization on app resume so the next verify hits the registry", async () => {
    await useP2pStore.getState().start();
    connectionEstablished?.({ connId: 7, peerId: PEER_BOB });
    const firstId = "11111111-1111-4111-8111-111111111111";
    const first = makeInboundStream(await inboundFrame(firstId));
    onStream?.(first);
    await vi.waitFor(async () =>
      expect(await getMessageById(firstId)).not.toBeNull()
    );
    const lookupsAfterFirst = lookupDeviceKey.mock.calls.length;
    expect(lookupsAfterFirst).toBeGreaterThan(0);
    expect(appResumeHandler).toBeTypeOf("function");

    // Resume must drop cached auth; re-auth needs a newer live head (not stuck 1n).
    appResumeHandler?.();
    lookupDeviceKey.mockClear();
    lookupDeviceKey.mockReturnValue(
      Effect.succeed({ ...bobAccount, blockNumber: 2n, freshness: "fresh" })
    );
    const secondId = "22222222-2222-4222-8222-222222222222";
    const second = makeInboundStream(await inboundFrame(secondId));
    onStream?.(second);
    await vi.waitFor(async () =>
      expect(await getMessageById(secondId)).not.toBeNull()
    );
    expect(lookupDeviceKey).toHaveBeenCalled();
  });

  it("resets when the sender cannot be verified", async () => {
    lookupDeviceKey.mockReturnValue(Effect.succeed(null));
    await useP2pStore.getState().start();
    connectionEstablished?.({ connId: 7, peerId: PEER_BOB });
    const stream = makeInboundStream(await inboundFrame(messageId));
    onStream?.(stream);
    await vi.waitFor(() => expect(stream.reset).toHaveBeenCalledOnce());
    expect(await getMessageById(messageId)).toBeNull();
    expect(stream.write).not.toHaveBeenCalled();
  });

  it("drops an in-flight receive across stop generations", async () => {
    const hung = Promise.withResolvers<Uint8Array | undefined>();
    await useP2pStore.getState().start();
    connectionEstablished?.({ connId: 7, peerId: PEER_BOB });
    const bytes = await inboundFrame(messageId);
    const stream = makeInboundStream(bytes);
    let reads = 0;
    stream.read = () => {
      reads += 1;

      return reads === 1 ? hung.promise : resolvedUndefined();
    };

    onStream?.(stream);
    const stopped = useP2pStore.getState().stop();
    hung.resolve(bytes);
    await stopped;
    expect(stream.reset).toHaveBeenCalledOnce();
    expect(await getMessageById(messageId)).toBeNull();
    expect(stream.write).not.toHaveBeenCalled();
  });

  it("invalidates verified connections on queue overflow", async () => {
    await useP2pStore.getState().start();
    connectionEstablished?.({ connId: 7, peerId: PEER_BOB });
    queueOverflow?.();
    expect(disconnect).toHaveBeenCalledWith(PEER_BOB);
  });
});

describe("peer paths", () => {
  it("tracks a relayed path upgrading to hole-punched", async () => {
    path.mockReturnValue({ kind: "relayed", relayPeerId: "relay" });
    await useP2pStore.getState().start();
    expect(runningConnection().peerPaths[PEER_BOB]?.kind).toBe("relayed");
    path.mockReturnValue({ kind: "punched" });
    pathUpgraded?.();
    expect(runningConnection().peerPaths[PEER_BOB]?.kind).toBe("punched");
  });
});

describe("connectTo", () => {
  it("replaces a connection that never finishes Identify", async () => {
    await useP2pStore.getState().start();
    isPeerReady.mockReturnValue(false);
    connect.mockResolvedValue({
      connectId: 1,
      path: { kind: "direct" },
      peerId: PEER_BOB,
    });

    const peerId = await useP2pStore
      .getState()
      .connectTo({ handle: "bob", qid: "1" });

    expect(disconnect).toHaveBeenCalledWith(PEER_BOB);
    expect(connect).toHaveBeenCalledWith(PEER_BOB, { timeoutMs: 15_000 });
    expect(peerId).toBe(PEER_BOB);
  });

  it("keeps a peer that becomes ready as the Identify wait times out", async () => {
    await useP2pStore.getState().start();
    isPeerReady.mockReturnValueOnce(false).mockReturnValue(true);
    waitPeerReady.mockRejectedValue(new Error("Identify timeout"));

    const peerId = await useP2pStore
      .getState()
      .connectTo({ handle: "bob", qid: "1" });

    expect(disconnect).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(peerId).toBe(PEER_BOB);
  });

  it("only reports peers that finished Identify as connected", async () => {
    isPeerReady.mockReturnValue(false);
    await useP2pStore.getState().start();
    expect(runningConnection().connectedPeerIds).toEqual([]);
  });
});
