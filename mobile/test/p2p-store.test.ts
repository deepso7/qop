import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteAll,
  getContactByQid,
  getMessageById,
  insertMessage,
  upsertContact,
} from "@/lib/db";
import { createP2pStore } from "@/lib/p2p-store-core";
import type { P2pEndpoint } from "@/lib/p2p-store-core";

let closed: Parameters<P2pEndpoint["onClose"]>[0] | undefined;
const send = vi.fn<() => Promise<void>>();
const useP2pStore = createP2pStore({
  createEndpoint: () => ({
    bindAppState: () => () => {},
    endpoint: {
      activeReservation: () => {},
      close: () => {},
      connect: () => Promise.reject(new Error("No dial in lifecycle fixture")),
      connectedPeers: () => [],
      disconnect: () => {},
      on: () => () => {},
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
  lookupHandle: () => Effect.succeed(null),
  performSend: send,
  randomUUID: () => crypto.randomUUID(),
});

beforeEach(async () => {
  vi.stubEnv("EXPO_PUBLIC_RELAY_ADDRS", "/test-relay");
  send.mockReset().mockResolvedValue();
  await deleteAll();
  await upsertContact({
    createdAt: 1,
    deviceKey: "device-bob",
    handle: "bob",
    owner: "owner-bob",
    peerId: "peer-bob",
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
});
