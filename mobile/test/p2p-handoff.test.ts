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
import { HANDOFF_REJECTED_MESSAGE } from "@/lib/p2p-sync";
import type { performHandoff, performPoll } from "@/lib/p2p-sync";
import type {
  lookupDeviceKey as LookupDeviceKey,
  lookupHandle as LookupHandle,
} from "@/lib/registry";
import type { RegistryAccount } from "@/lib/registry-core";

const PEER_BOB = "12D3KooWC7cDcNR4J3NC9y1gTkqafZKmnjCUvrRMxU2LMugGJGgy";
const PEER_CLI = "12D3KooWDGEF3VLEM7R3XWGJsqPCcSSjwRmuNw6JTQMVMNSSzwAz";
const PEER_CLI_OTHER =
  "12D3KooWaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PEER_ALICE = "12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X";
const phoneDeviceKey = `0x${"11".repeat(32)}`;
const cliDeviceKey = `0x${"33".repeat(32)}`;
const otherCliDeviceKey = `0x${"44".repeat(32)}`;
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
      expect(await getMessageById(id)).toMatchObject({
        holderPeerId: PEER_CLI,
        status: "held",
      })
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

  it("keeps a reconciled hold when the original send later fails", async () => {
    const pendingSend = Promise.withResolvers<true>();
    send.mockImplementation(async () => {
      await pendingSend.promise;
    });
    handoff.mockRejectedValueOnce(new Error("connection replaced"));
    await useP2pStore.getState().start();
    const contact = await getContactByQid("1");
    if (!contact) {
      throw new Error("Missing contact fixture");
    }
    const id = useP2pStore.getState().sendMessage(contact, "hello");
    await vi.waitFor(() => expect(handoff).toHaveBeenCalledOnce());
    connectionEstablished?.({ connId: 2, peerId: PEER_CLI });
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({ status: "held" })
    );
    const { revision } = useP2pStore.getState();
    pendingSend.reject(new Error("bob offline"));
    await vi.waitFor(() =>
      expect(useP2pStore.getState().revision).toBeGreaterThan(revision)
    );
    expect(await getMessageById(id)).toMatchObject({ status: "held" });
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
      holderPeerId: PEER_CLI,
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
    handoff.mockRejectedValue(new Error(HANDOFF_REJECTED_MESSAGE));
    await useP2pStore.getState().start();
    connectionEstablished?.({ connId: 2, peerId: PEER_CLI });
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({ status: "failed" })
    );
    expect(handoff).toHaveBeenCalled();
  });

  it("does not hand failed messages to the CLI until the user retries", async () => {
    const heldId = "c56a4180-65aa-42ec-a945-5fd21dec0540";
    const failedId = "c56a4180-65aa-42ec-a945-5fd21dec0541";
    await insertMessage({
      contactQid: "1",
      direction: "out",
      holderPeerId: PEER_CLI,
      id: heldId,
      sentAt: 1,
      status: "held",
      text: "waiting",
    });
    await insertMessage({
      contactQid: "1",
      direction: "out",
      id: failedId,
      sentAt: 1,
      status: "failed",
      text: "old",
    });
    poll.mockResolvedValue([]);
    await useP2pStore.getState().start();
    connectionEstablished?.({ connId: 2, peerId: PEER_CLI });
    await vi.waitFor(() =>
      expect(handoff).toHaveBeenCalledWith(
        expect.objectContaining({
          holderPeerId: PEER_CLI,
          record: expect.objectContaining({
            frame: expect.objectContaining({ id: heldId }),
          }),
        })
      )
    );
    expect(
      handoff.mock.calls.some((call) => call[0]?.record.frame.id === failedId)
    ).toBe(false);
    expect(await getMessageById(failedId)).toMatchObject({
      holderPeerId: null,
      status: "failed",
    });
  });

  it("polls the stored holder even when another own device would be picked", async () => {
    const id = "c56a4180-65aa-42ec-a945-5fd21dec0542";
    lookupHandle.mockImplementation((handle: string) =>
      Effect.succeed(
        handle === "alice"
          ? {
              ...aliceAccount,
              devices: [
                { deviceKey: phoneDeviceKey, peerId: PEER_ALICE },
                { deviceKey: otherCliDeviceKey, peerId: PEER_CLI_OTHER },
                { deviceKey: cliDeviceKey, peerId: PEER_CLI },
              ],
            }
          : bobAccount
      )
    );
    connectedPeers.mockReturnValue([PEER_CLI_OTHER, PEER_CLI]);
    await insertMessage({
      contactQid: "1",
      direction: "out",
      holderPeerId: PEER_CLI,
      id,
      sentAt: 1,
      status: "held",
      text: "hello",
    });
    poll.mockResolvedValue([{ deliveredAt: 9, id }]);
    await useP2pStore.getState().start();
    connectionEstablished?.({ connId: 2, peerId: PEER_CLI_OTHER });
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({ status: "sent" })
    );
    expect(poll).toHaveBeenCalledWith(
      expect.objectContaining({
        holderPeerId: PEER_CLI,
        ids: [id],
      })
    );
    expect(poll).not.toHaveBeenCalledWith(
      expect.objectContaining({ holderPeerId: PEER_CLI_OTHER })
    );
  });

  it("re-looks up own-device holders after an empty registry snapshot", async () => {
    const phoneOnly: RegistryAccount = {
      ...aliceAccount,
      devices: [{ deviceKey: phoneDeviceKey, peerId: PEER_ALICE }],
    };
    lookupHandle.mockImplementation((handle: string) =>
      Effect.succeed(handle === "alice" ? phoneOnly : bobAccount)
    );
    await useP2pStore.getState().start();
    const contact = await getContactByQid("1");
    if (!contact) {
      throw new Error("Missing contact fixture");
    }
    const first = useP2pStore.getState().sendMessage(contact, "one");
    await vi.waitFor(async () =>
      expect(await getMessageById(first)).toMatchObject({ status: "failed" })
    );
    expect(handoff).not.toHaveBeenCalled();

    lookupHandle.mockImplementation((handle: string) =>
      Effect.succeed(handle === "alice" ? aliceAccount : bobAccount)
    );
    const second = useP2pStore.getState().sendMessage(contact, "two");
    await vi.waitFor(async () =>
      expect(await getMessageById(second)).toMatchObject({
        holderPeerId: PEER_CLI,
        status: "held",
      })
    );
  });

  it("reuses the own-device registry lookup across outgoing sends", async () => {
    await useP2pStore.getState().start();
    const contact = await getContactByQid("1");
    if (!contact) {
      throw new Error("Missing contact fixture");
    }
    const first = useP2pStore.getState().sendMessage(contact, "one");
    await vi.waitFor(async () =>
      expect(await getMessageById(first)).toMatchObject({ status: "held" })
    );
    lookupHandle.mockClear();
    const second = useP2pStore.getState().sendMessage(contact, "two");
    await vi.waitFor(async () =>
      expect(await getMessageById(second)).toMatchObject({ status: "held" })
    );
    expect(
      lookupHandle.mock.calls.filter(([handle]) => handle === "alice")
    ).toEqual([]);
  });

  it("does not reconcile when a chat peer connects", async () => {
    await insertMessage({
      contactQid: "1",
      direction: "out",
      holderPeerId: PEER_CLI,
      id: "c56a4180-65aa-42ec-a945-5fd21dec0543",
      sentAt: 1,
      status: "held",
      text: "hello",
    });
    poll.mockResolvedValue([]);
    await useP2pStore.getState().start();
    await vi.waitFor(() => expect(poll).toHaveBeenCalled());
    poll.mockClear();
    handoff.mockClear();
    connectionEstablished?.({ connId: 3, peerId: PEER_BOB });
    await Effect.runPromise(Effect.sleep(50));
    expect(poll).not.toHaveBeenCalled();
    expect(handoff).not.toHaveBeenCalled();
  });

  it("coalesces reconcile when several own devices connect together", async () => {
    lookupHandle.mockImplementation((handle: string) =>
      Effect.succeed(
        handle === "alice"
          ? {
              ...aliceAccount,
              devices: [
                { deviceKey: phoneDeviceKey, peerId: PEER_ALICE },
                { deviceKey: cliDeviceKey, peerId: PEER_CLI },
                { deviceKey: otherCliDeviceKey, peerId: PEER_CLI_OTHER },
              ],
            }
          : bobAccount
      )
    );
    const id = "c56a4180-65aa-42ec-a945-5fd21dec0544";
    await insertMessage({
      contactQid: "1",
      direction: "out",
      holderPeerId: PEER_CLI,
      id,
      sentAt: 1,
      status: "held",
      text: "hello",
    });
    poll.mockResolvedValue([]);
    await useP2pStore.getState().start();
    await vi.waitFor(() => expect(poll).toHaveBeenCalled());
    poll.mockClear();
    handoff.mockClear();
    connectionEstablished?.({ connId: 2, peerId: PEER_CLI });
    connectionEstablished?.({ connId: 3, peerId: PEER_CLI_OTHER });
    await vi.waitFor(() => expect(poll).toHaveBeenCalled());
    expect(poll).toHaveBeenCalledTimes(1);
  });
});
