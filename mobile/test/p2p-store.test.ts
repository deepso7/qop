import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CHAT_PROTOCOL, encodeAck, encodeFrame } from "@/lib/chat-wire";
import {
  deleteAll,
  getContactByQid,
  getMessageById,
  insertMessage,
  upsertContact,
} from "@/lib/db";
import type { performSend } from "@/lib/p2p-send";
import { createP2pStore } from "@/lib/p2p-store-core";
import type { P2pEndpoint } from "@/lib/p2p-store-core";
import type { RegistryAccount } from "@/lib/registry-core";
import type { lookupDeviceKey as LookupDeviceKey } from "@/lib/registry";
import type { lookupHandle as LookupHandle } from "@/lib/registry";

const PEER_BOB = "12D3KooWC7cDcNR4J3NC9y1gTkqafZKmnjCUvrRMxU2LMugGJGgy";

const bobAccount: RegistryAccount = {
  blockNumber: 1n,
  freshness: "fresh",
  deviceKey: `0x${"22".repeat(32)}`,
  devices: [
    {
      deviceKey: `0x${"22".repeat(32)}`,
      peerId: PEER_BOB,
    },
  ],
  handle: "bob",
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
let driverFailed: ((event: { detail: string }) => void) | undefined;
let connectionEstablished: ((connection: Connection) => void) | undefined;
let onStream: ((stream: InboundStream) => void) | undefined;
let queueOverflow: (() => void) | undefined;
const disconnect = vi.fn();
const connectedPeers = vi.fn((): string[] => [PEER_BOB]);
const send = vi.fn<typeof performSend>();
const lookupDeviceKey = vi.fn(
  (): ReturnType<typeof LookupDeviceKey> => Effect.succeed(bobAccount)
);
const lookupHandle = vi.fn(
  (): ReturnType<typeof LookupHandle> => Effect.succeed(bobAccount)
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
  createEndpoint: () => ({
    bindAppState: () => () => {},
    endpoint: {
      activeReservation: () => {},
      close: () => {},
      connect: () => Promise.reject(new Error("No dial in lifecycle fixture")),
      connectedPeers,
      disconnect,
      on: captureEndpointEvent,
      onClose: (callback) => {
        closed = callback;
        return () => {
          closed = undefined;
        };
      },
      openStream: () =>
        Promise.reject(new Error("No stream in lifecycle fixture")),
      peerId: () => "peer-alice",
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
  vi.stubEnv("EXPO_PUBLIC_RELAY_ADDRS", "/test-relay");
  send.mockReset().mockResolvedValue();
  lookupDeviceKey.mockReset().mockReturnValue(Effect.succeed(bobAccount));
  lookupHandle.mockReset().mockReturnValue(Effect.succeed(bobAccount));
  disconnect.mockReset();
  connectedPeers.mockReset().mockReturnValue([PEER_BOB]);
  closed = undefined;
  driverFailed = undefined;
  connectionEstablished = undefined;
  onStream = undefined;
  queueOverflow = undefined;
  await deleteAll();
  await upsertContact({
    createdAt: 1,
    deviceKey: bobAccount.deviceKey!,
    handle: "bob",
    owner: bobAccount.owner,
    peerId: PEER_BOB,
    qid: "1",
  });
});
afterEach(async () => {
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

const inboundFrame = (id: string) =>
  encodeFrame({
    fromHandle: "bob",
    id,
    sentAt: 1,
    text: "hello inbound",
    v: 1,
  });

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
    write: vi.fn(),
  };
};

// Promise.resolve(undefined) without tripping unicorn/no-useless-undefined.
const resolvedUndefined = async (): Promise<undefined> => {
  await Promise.resolve();
};

describe("interrupted sends", () => {
  it("recovers a persisted send before starting a new endpoint", async () => {
    await insertMessage({
      contactQid: "1",
      direction: "out",
      id: "interrupted",
      sentAt: 1,
      status: "sending",
      text: "hello",
    });
    await useP2pStore.getState().start();
    expect(await getMessageById("interrupted")).toMatchObject({
      status: "failed",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("makes an endpoint-interrupted send retryable with its original ID", async () => {
    const { id, pending } = await beginSend();
    closed?.({ reason: "close" });
    pending.reject(new Error("connection closed"));
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({ status: "failed" })
    );
    await useP2pStore.getState().start();
    await useP2pStore.getState().retryMessage(id);
    expect(await getMessageById(id)).toMatchObject({
      id,
      status: "sent",
      text: "hello",
    });
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
    expect(await getMessageById(id)).toMatchObject({ status: "failed" });
  });

  it("tears down and recovers interrupted sends on driverFailed", async () => {
    const { id, pending } = await beginSend();
    expect(useP2pStore.getState().status).toBe("running");
    expect(useP2pStore.getState().peerId).toBe("peer-alice");
    driverFailed?.({ detail: "native panic" });
    pending.reject(new Error("driver failed"));
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({ status: "failed" })
    );
    expect(useP2pStore.getState()).toMatchObject({
      connectedPeerIds: [],
      error: "native panic",
      peerId: undefined,
      status: "failed",
    });
  });

  it("restarts from failed before retrying a message", async () => {
    const { id, pending } = await beginSend();
    closed?.({ reason: "close" });
    pending.reject(new Error("connection closed"));
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({ status: "failed" })
    );
    expect(useP2pStore.getState().status).toBe("failed");
    // retryMessage should call start itself — no prior start() from the test.
    await useP2pStore.getState().retryMessage(id);
    expect(await getMessageById(id)).toMatchObject({
      id,
      status: "sent",
      text: "hello",
    });
    expect(useP2pStore.getState().status).toBe("running");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent retries for the same message", async () => {
    const { id, pending } = await beginSend();
    closed?.({ reason: "close" });
    pending.reject(new Error("connection closed"));
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({ status: "failed" })
    );
    await useP2pStore.getState().start();
    const retryPending = Promise.withResolvers<undefined>();
    send.mockReturnValueOnce(retryPending.promise);

    const first = useP2pStore.getState().retryMessage(id);
    const second = useP2pStore.getState().retryMessage(id);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    retryPending.resolve(await resolvedUndefined());
    await Promise.all([first, second]);

    expect(await getMessageById(id)).toMatchObject({ status: "sent" });
  });

  it("retries after a capped stop cancels an abandoned retry", async () => {
    const { id, pending } = await beginSend();
    closed?.({ reason: "close" });
    pending.reject(new Error("connection closed"));
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({ status: "failed" })
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
      expect(await getMessageById(id)).toMatchObject({ status: "failed" });

      const freshRetry = useP2pStore.getState().retryMessage(id);
      await vi.advanceTimersByTimeAsync(5000);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
      await freshRetry;
      expect(await getMessageById(id)).toMatchObject({ status: "sent" });

      abandoned.resolve(await resolvedUndefined());
      await oldRetry;
      expect(await getMessageById(id)).toMatchObject({ status: "sent" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("inbound chat streams", () => {
  const messageId = "c56a4180-65aa-42ec-a945-5fd21dec0538";

  it("acks a verified inbound frame and stores it", async () => {
    await useP2pStore.getState().start();
    connectionEstablished?.({ connId: 7, peerId: PEER_BOB });
    const stream = makeInboundStream(inboundFrame(messageId));
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

  it("invalidates authorization on app resume so the next verify hits the registry", async () => {
    await useP2pStore.getState().start();
    connectionEstablished?.({ connId: 7, peerId: PEER_BOB });
    const firstId = "11111111-1111-4111-8111-111111111111";
    const first = makeInboundStream(inboundFrame(firstId));
    onStream?.(first);
    await vi.waitFor(async () =>
      expect(await getMessageById(firstId)).not.toBeNull()
    );
    const lookupsAfterFirst = lookupDeviceKey.mock.calls.length;
    expect(lookupsAfterFirst).toBeGreaterThan(0);
    expect(appResumeHandler).toBeTypeOf("function");

    // Resume must drop cached auth; a second inbound on the same conn re-checks.
    appResumeHandler?.();
    lookupDeviceKey.mockClear();
    const secondId = "22222222-2222-4222-8222-222222222222";
    const second = makeInboundStream(inboundFrame(secondId));
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
    const stream = makeInboundStream(inboundFrame(messageId));
    onStream?.(stream);
    await vi.waitFor(() => expect(stream.reset).toHaveBeenCalledOnce());
    expect(await getMessageById(messageId)).toBeNull();
    expect(stream.write).not.toHaveBeenCalled();
  });

  it("drops an in-flight receive across stop generations", async () => {
    const hung = Promise.withResolvers<Uint8Array | undefined>();
    await useP2pStore.getState().start();
    connectionEstablished?.({ connId: 7, peerId: PEER_BOB });
    const stream = makeInboundStream(inboundFrame(messageId));
    let reads = 0;
    stream.read = () => {
      reads += 1;
      return reads === 1 ? hung.promise : resolvedUndefined();
    };
    onStream?.(stream);
    const stopped = useP2pStore.getState().stop();
    hung.resolve(inboundFrame(messageId));
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
