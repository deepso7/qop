import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import type { performHandoff, performPoll } from "@/lib/p2p-sync";
import type {
  lookupDeviceKey as LookupDeviceKey,
  lookupHandle as LookupHandle,
} from "@/lib/registry";
import type { RegistryAccount } from "@/lib/registry-core";

const PEER_BOB = "12D3KooWC7cDcNR4J3NC9y1gTkqafZKmnjCUvrRMxU2LMugGJGgy";
const PEER_CLI = "12D3KooWDGEF3VLEM7R3XWGJsqPCcSSjwRmuNw6JTQMVMNSSzwAz";
const PEER_ALICE = "12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X";
const phoneDeviceKey = `0x${"11".repeat(32)}`;
const cliDeviceKey = `0x${"33".repeat(32)}`;
const bobDeviceKey = `0x${"22".repeat(32)}`;

const aliceAccount: RegistryAccount = {
  blockNumber: 1n,
  deviceKey: phoneDeviceKey,
  devices: [
    { deviceKey: phoneDeviceKey, peerId: PEER_ALICE },
    { deviceKey: cliDeviceKey, peerId: PEER_CLI },
  ],
  freshness: "fresh",
  handle: "alice",
  nonce: 0n,
  owner: "0x0000000000000000000000000000000000000001",
  ownerVersion: 0,
  peerId: PEER_ALICE,
  qid: 42n,
  registeredAt: 1n,
};

const bobAccount: RegistryAccount = {
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

interface Connection {
  readonly connId: number;
  readonly peerId: string;
}

let connectionEstablished: ((connection: Connection) => void) | undefined;
const connectedPeers = vi.fn((): string[] => [PEER_CLI]);
const send = vi.fn<typeof performSend>();
const handoff = vi.fn<typeof performHandoff>();
const poll = vi.fn<typeof performPoll>();
const lookupDeviceKey = vi.fn((): ReturnType<typeof LookupDeviceKey> =>
  Effect.succeed(bobAccount)
);
const lookupHandle = vi.fn((handle: string): ReturnType<typeof LookupHandle> =>
  Effect.succeed(handle === "alice" ? aliceAccount : bobAccount)
);

type EventListener = (event: never) => void;

const captureEndpointEvent: P2pEndpoint["on"] = (
  typeOrHandler: string | EventListener,
  maybeHandler?: EventListener
) => {
  if (!maybeHandler) {
    return () => {};
  }
  if (typeOrHandler === "connectionEstablished") {
    // SAFETY: This branch only runs for the connectionEstablished registration.
    connectionEstablished = maybeHandler as (connection: Connection) => void;
    return () => {
      connectionEstablished = undefined;
    };
  }
  return () => {};
};

const useP2pStore = createP2pStore({
  createEndpoint: () => ({
    bindAppState: () => () => {},
    endpoint: {
      activeReservation: () => {},
      close: () => {},
      connect: () => Promise.reject(new Error("No dial in handoff fixture")),
      connectAddr: () =>
        Promise.reject(new Error("No pairing dial in handoff fixture")),
      connectWithAddrs: () =>
        Promise.reject(new Error("No pairing dial in handoff fixture")),
      connectedPeers,
      disconnect: vi.fn(),
      on: captureEndpointEvent,
      onClose: () => () => {},
      openStream: () =>
        Promise.reject(new Error("No stream in handoff fixture")),
      peerId: () => PEER_ALICE,
      waitPeerReady: () =>
        Promise.reject(new Error("No pairing wait in handoff fixture")),
    },
  }),
  getIdentityHandle: () => "alice",
  getOwnDevice: () => ({
    deviceKey: phoneDeviceKey,
    handle: "alice",
    peerId: PEER_ALICE,
    qid: "42",
  }),
  loadDeviceSecretKey: () => Effect.succeed(new Uint8Array(32)),
  lookupDeviceKey,
  lookupHandle,
  performHandoff: handoff,
  performPoll: poll,
  performSend: send,
  randomUUID: () => crypto.randomUUID(),
});

beforeEach(async () => {
  vi.stubEnv("EXPO_PUBLIC_RELAY_ADDRS", "/test-relay");
  send.mockReset().mockRejectedValue(new Error("bob offline"));
  handoff.mockReset().mockResolvedValue();
  poll.mockReset().mockResolvedValue([]);
  lookupDeviceKey.mockReset().mockReturnValue(Effect.succeed(bobAccount));
  lookupHandle
    .mockReset()
    .mockImplementation((handle: string) =>
      Effect.succeed(handle === "alice" ? aliceAccount : bobAccount)
    );
  connectedPeers.mockReset().mockReturnValue([PEER_CLI]);
  connectionEstablished = undefined;
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
  await useP2pStore.getState().stop();
  vi.unstubAllEnvs();
});

describe("phone to CLI handoff", () => {
  it("marks a send held when the CLI accepts and Bob does not", async () => {
    await useP2pStore.getState().start();
    const contact = await getContactByQid("1");
    if (!contact) {
      throw new Error("Missing contact fixture");
    }
    const id = useP2pStore.getState().sendMessage(contact, "hello");
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({ status: "held" })
    );
    expect(send).toHaveBeenCalledOnce();
    expect(handoff).toHaveBeenCalled();
    expect(handoff).toHaveBeenCalledWith(
      expect.objectContaining({
        composedBy: phoneDeviceKey,
        holderPeerId: PEER_CLI,
        record: expect.objectContaining({
          frame: expect.objectContaining({ id, text: "hello" }),
          toHandle: "bob",
          toQid: "1",
        }),
      })
    );
  });

  it("prefers Bob's ack over held", async () => {
    send.mockResolvedValue();
    await useP2pStore.getState().start();
    const contact = await getContactByQid("1");
    if (!contact) {
      throw new Error("Missing contact fixture");
    }
    const id = useP2pStore.getState().sendMessage(contact, "hello");
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({ status: "sent" })
    );
    expect(handoff).toHaveBeenCalled();
  });

  it("marks sent when Bob acks without waiting for CLI handoff", async () => {
    send.mockResolvedValue();
    const deferred = Promise.withResolvers<true>();
    handoff.mockImplementation(async () => {
      await deferred.promise;
    });
    await useP2pStore.getState().start();
    const contact = await getContactByQid("1");
    if (!contact) {
      throw new Error("Missing contact fixture");
    }
    const id = useP2pStore.getState().sendMessage(contact, "hello");
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({ status: "sent" })
    );
    expect(handoff).toHaveBeenCalled();
    deferred.resolve(true);
  });

  it("applies a CLI receipt onto a held message", async () => {
    await insertMessage({
      contactQid: "1",
      direction: "out",
      id: "c56a4180-65aa-42ec-a945-5fd21dec0538",
      sentAt: 1,
      status: "held",
      text: "hello",
    });
    poll.mockResolvedValue([
      { deliveredAt: 9, id: "c56a4180-65aa-42ec-a945-5fd21dec0538" },
    ]);
    await useP2pStore.getState().start();
    connectionEstablished?.({ connId: 2, peerId: PEER_CLI });
    await vi.waitFor(async () =>
      expect(
        await getMessageById("c56a4180-65aa-42ec-a945-5fd21dec0538")
      ).toMatchObject({ status: "sent" })
    );
  });

  it("marks held failed when CLI later reports the id invalid", async () => {
    const id = "c56a4180-65aa-42ec-a945-5fd21dec0539";
    await insertMessage({
      contactQid: "1",
      direction: "out",
      id,
      sentAt: 1,
      status: "held",
      text: "hello",
    });
    poll.mockResolvedValue([]);
    handoff.mockRejectedValue(new Error("CLI did not accept the handoff"));
    await useP2pStore.getState().start();
    connectionEstablished?.({ connId: 2, peerId: PEER_CLI });
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({ status: "failed" })
    );
    expect(handoff).toHaveBeenCalled();
  });
});
