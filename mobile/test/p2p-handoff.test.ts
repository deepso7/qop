import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteAll,
  getContactByQid,
  getHolderInboxCursor,
  getMessageById,
  insertMessage,
  upsertContact,
} from "@/lib/db";
import type { performSend } from "@/lib/p2p-send";
import { createP2pStore } from "@/lib/p2p-store-core";
import type { P2pEndpoint } from "@/lib/p2p-store-core";
import { HANDOFF_REJECTED_MESSAGE } from "@/lib/p2p-sync";
import type {
  performCatchup,
  performHandoff,
  performPoll,
} from "@/lib/p2p-sync";
import type {
  lookupDeviceKey as LookupDeviceKey,
  lookupHandle as LookupHandle,
  lookupQid as LookupQid,
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
const catchup = vi.fn<typeof performCatchup>();
const lookupQid = vi.fn<typeof LookupQid>(() => Effect.succeed(null));
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
  lookupQid,
  performCatchup: catchup,
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
  catchup.mockReset().mockResolvedValue([]);
  lookupQid.mockReset().mockImplementation(() => Effect.succeed(null));
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
      {
        deliveredAt: 9,
        id: "c56a4180-65aa-42ec-a945-5fd21dec0538",
        toQid: "1",
      },
    ]);
    await useP2pStore.getState().start();
    connectionEstablished?.({ connId: 2, peerId: PEER_CLI });
    await vi.waitFor(async () =>
      expect(
        await getMessageById("c56a4180-65aa-42ec-a945-5fd21dec0538")
      ).toMatchObject({ status: "sent" })
    );
  });

  it("does not apply one contact's receipt onto another contact's same id", async () => {
    const sharedId = "c56a4180-65aa-42ec-a945-5fd21dec0548";
    await upsertContact({
      createdAt: 2,
      deviceKey: `0x${"55".repeat(32)}`,
      handle: "carol",
      owner: bobAccount.owner,
      peerId: "carol-peer",
      qid: "2",
    });
    // Insert Carol first so an id-only find() would pick her row.
    expect(
      await insertMessage({
        contactQid: "2",
        direction: "out",
        holderPeerId: PEER_CLI,
        id: sharedId,
        sentAt: 1,
        status: "held",
        text: "to carol",
      })
    ).toBe(true);
    expect(
      await insertMessage({
        contactQid: "1",
        direction: "out",
        holderPeerId: PEER_CLI,
        id: sharedId,
        sentAt: 1,
        status: "held",
        text: "to bob",
      })
    ).toBe(true);
    poll.mockResolvedValue([{ deliveredAt: 9, id: sharedId, toQid: "1" }]);
    await useP2pStore.getState().start();
    connectionEstablished?.({ connId: 2, peerId: PEER_CLI });
    await vi.waitFor(async () =>
      expect(await getMessageById(sharedId, "1")).toMatchObject({
        status: "sent",
        text: "to bob",
      })
    );
    expect(await getMessageById(sharedId, "2")).toMatchObject({
      status: "held",
      text: "to carol",
    });
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
    await vi.waitFor(() => expect(poll).toHaveBeenCalled());
    await Effect.runPromise(Effect.sleep(50));
    expect(handoff).not.toHaveBeenCalled();
    expect(await getMessageById(heldId)).toMatchObject({
      holderPeerId: PEER_CLI,
      status: "held",
    });
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
    poll.mockResolvedValue([{ deliveredAt: 9, id, toQid: "1" }]);
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

  it("hands off to a CLI linked after a non-empty own-device roster lookup", async () => {
    await useP2pStore.getState().start();
    const contact = await getContactByQid("1");
    if (!contact) {
      throw new Error("Missing contact fixture");
    }
    const first = useP2pStore.getState().sendMessage(contact, "one");
    await vi.waitFor(async () =>
      expect(await getMessageById(first)).toMatchObject({
        holderPeerId: PEER_CLI,
        status: "held",
      })
    );

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
    connectedPeers.mockReturnValue([PEER_CLI_OTHER]);
    handoff.mockClear();
    poll.mockClear();

    const pendingId = "c56a4180-65aa-42ec-a945-5fd21dec0545";
    await insertMessage({
      contactQid: "1",
      direction: "out",
      id: pendingId,
      sentAt: 2,
      status: "sending",
      text: "pending",
    });
    connectionEstablished?.({ connId: 4, peerId: PEER_CLI_OTHER });
    await vi.waitFor(async () =>
      expect(await getMessageById(pendingId)).toMatchObject({
        holderPeerId: PEER_CLI_OTHER,
        status: "held",
      })
    );

    const second = useP2pStore.getState().sendMessage(contact, "two");
    await vi.waitFor(async () =>
      expect(await getMessageById(second)).toMatchObject({
        holderPeerId: PEER_CLI_OTHER,
        status: "held",
      })
    );
  });

  const aliceLookups = () =>
    lookupHandle.mock.calls.filter(([handle]) => handle === "alice");

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
    expect(aliceLookups()).toEqual([]);
  });

  it("does not look up own devices when an unauthenticated peer connects", async () => {
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

    for (let i = 0; i < 5; i += 1) {
      connectionEstablished?.({ connId: 10 + i, peerId: PEER_BOB });
    }
    await Effect.runPromise(Effect.sleep(50));
    for (let i = 0; i < 5; i += 1) {
      connectionEstablished?.({ connId: 20 + i, peerId: PEER_BOB });
    }
    await Effect.runPromise(Effect.sleep(50));
    expect(aliceLookups()).toEqual([]);

    const second = useP2pStore.getState().sendMessage(contact, "two");
    await vi.waitFor(async () =>
      expect(await getMessageById(second)).toMatchObject({
        holderPeerId: PEER_CLI,
        status: "held",
      })
    );
    expect(aliceLookups()).toEqual([]);
  });

  it("probes the own-device roster at most once when no cached holder is connected", async () => {
    await useP2pStore.getState().start();
    const contact = await getContactByQid("1");
    if (!contact) {
      throw new Error("Missing contact fixture");
    }
    const first = useP2pStore.getState().sendMessage(contact, "one");
    await vi.waitFor(async () =>
      expect(await getMessageById(first)).toMatchObject({ status: "held" })
    );
    connectedPeers.mockReturnValue([]);
    lookupHandle.mockClear();

    connectionEstablished?.({ connId: 10, peerId: PEER_BOB });
    await vi.waitFor(() => expect(aliceLookups()).toHaveLength(1));
    for (let i = 0; i < 4; i += 1) {
      connectionEstablished?.({ connId: 11 + i, peerId: PEER_BOB });
    }
    await Effect.runPromise(Effect.sleep(50));
    expect(aliceLookups()).toHaveLength(1);

    connectedPeers.mockReturnValue([PEER_CLI]);
    const second = useP2pStore.getState().sendMessage(contact, "two");
    await vi.waitFor(async () =>
      expect(await getMessageById(second)).toMatchObject({
        holderPeerId: PEER_CLI,
        status: "held",
      })
    );
    expect(aliceLookups()).toHaveLength(1);
  });

  it("reconciles a CLI linked after stranger churn with no holder online", async () => {
    await useP2pStore.getState().start();
    const contact = await getContactByQid("1");
    if (!contact) {
      throw new Error("Missing contact fixture");
    }
    const first = useP2pStore.getState().sendMessage(contact, "one");
    await vi.waitFor(async () =>
      expect(await getMessageById(first)).toMatchObject({
        holderPeerId: PEER_CLI,
        status: "held",
      })
    );

    connectedPeers.mockReturnValue([]);
    lookupHandle.mockClear();
    connectionEstablished?.({ connId: 10, peerId: PEER_BOB });
    await vi.waitFor(() => expect(aliceLookups()).toHaveLength(1));
    for (let i = 0; i < 4; i += 1) {
      connectionEstablished?.({ connId: 11 + i, peerId: PEER_BOB });
    }
    await Effect.runPromise(Effect.sleep(50));
    expect(aliceLookups()).toHaveLength(1);

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
    connectedPeers.mockReturnValue([PEER_CLI_OTHER]);
    handoff.mockClear();

    const pendingId = "c56a4180-65aa-42ec-a945-5fd21dec0546";
    await insertMessage({
      contactQid: "1",
      direction: "out",
      id: pendingId,
      sentAt: 2,
      status: "sending",
      text: "pending",
    });
    connectionEstablished?.({ connId: 20, peerId: PEER_CLI_OTHER });
    await vi.waitFor(async () =>
      expect(await getMessageById(pendingId)).toMatchObject({
        holderPeerId: PEER_CLI_OTHER,
        status: "held",
      })
    );
  });

  it("reconciles a CLI linked after an empty roster stranger probe", async () => {
    const phoneOnly: RegistryAccount = {
      ...aliceAccount,
      devices: [{ deviceKey: phoneDeviceKey, peerId: PEER_ALICE }],
    };
    lookupHandle.mockImplementation((handle: string) =>
      Effect.succeed(handle === "alice" ? phoneOnly : bobAccount)
    );
    await useP2pStore.getState().start();
    await vi.waitFor(() => expect(aliceLookups().length).toBeGreaterThan(0));
    lookupHandle.mockClear();

    connectionEstablished?.({ connId: 10, peerId: PEER_BOB });
    await vi.waitFor(() => expect(aliceLookups()).toHaveLength(1));
    for (let i = 0; i < 4; i += 1) {
      connectionEstablished?.({ connId: 11 + i, peerId: PEER_BOB });
    }
    await Effect.runPromise(Effect.sleep(50));
    expect(aliceLookups()).toHaveLength(1);

    lookupHandle.mockImplementation((handle: string) =>
      Effect.succeed(handle === "alice" ? aliceAccount : bobAccount)
    );
    connectedPeers.mockReturnValue([PEER_CLI]);
    const contact = await getContactByQid("1");
    if (!contact) {
      throw new Error("Missing contact fixture");
    }
    const pendingId = "c56a4180-65aa-42ec-a945-5fd21dec0547";
    await insertMessage({
      contactQid: "1",
      direction: "out",
      id: pendingId,
      sentAt: 2,
      status: "sending",
      text: "pending",
    });
    connectionEstablished?.({ connId: 20, peerId: PEER_CLI });
    await vi.waitFor(async () =>
      expect(await getMessageById(pendingId)).toMatchObject({
        holderPeerId: PEER_CLI,
        status: "held",
      })
    );
  });

  it("reconciles a CLI that pair-connected before the registry listed it", async () => {
    const phoneOnly: RegistryAccount = {
      ...aliceAccount,
      devices: [{ deviceKey: phoneDeviceKey, peerId: PEER_ALICE }],
    };
    lookupHandle.mockImplementation((handle: string) =>
      Effect.succeed(handle === "alice" ? phoneOnly : bobAccount)
    );
    await useP2pStore.getState().start();
    await vi.waitFor(() => expect(aliceLookups().length).toBeGreaterThan(0));
    lookupHandle.mockClear();
    connectedPeers.mockReturnValue([PEER_CLI]);

    connectionEstablished?.({ connId: 10, peerId: PEER_CLI });
    await vi.waitFor(() => expect(aliceLookups()).toHaveLength(1));
    await Effect.runPromise(Effect.sleep(50));
    expect(aliceLookups()).toHaveLength(1);

    const pendingId = "c56a4180-65aa-42ec-a945-5fd21dec0548";
    await insertMessage({
      contactQid: "1",
      direction: "out",
      id: pendingId,
      sentAt: 2,
      status: "sending",
      text: "pending",
    });
    lookupHandle.mockImplementation((handle: string) =>
      Effect.succeed(handle === "alice" ? aliceAccount : bobAccount)
    );
    connectionEstablished?.({ connId: 11, peerId: PEER_CLI });
    await Effect.runPromise(Effect.sleep(50));
    expect(aliceLookups()).toHaveLength(1);
    expect(await getMessageById(pendingId)).toMatchObject({
      status: "sending",
    });

    useP2pStore.getState().invalidateOwnHolders();
    connectionEstablished?.({ connId: 12, peerId: PEER_CLI });
    await vi.waitFor(async () =>
      expect(await getMessageById(pendingId)).toMatchObject({
        holderPeerId: PEER_CLI,
        status: "held",
      })
    );
  });

  it("reconciles a CLI that connects while a stranger roster probe is in flight", async () => {
    const phoneOnly: RegistryAccount = {
      ...aliceAccount,
      devices: [{ deviceKey: phoneDeviceKey, peerId: PEER_ALICE }],
    };
    lookupHandle.mockImplementation((handle: string) =>
      Effect.succeed(handle === "alice" ? phoneOnly : bobAccount)
    );
    await useP2pStore.getState().start();
    lookupHandle.mockClear();

    const firstAlice = Promise.withResolvers<RegistryAccount>();
    let aliceReads = 0;
    lookupHandle.mockImplementation((handle: string) => {
      if (handle !== "alice") {
        return Effect.succeed(bobAccount);
      }
      aliceReads += 1;
      if (aliceReads === 1) {
        return Effect.promise(() => firstAlice.promise);
      }
      return Effect.succeed(aliceAccount);
    });

    connectedPeers.mockReturnValue([]);
    connectionEstablished?.({ connId: 10, peerId: PEER_BOB });
    await vi.waitFor(() => expect(aliceReads).toBe(1));

    const pendingId = "c56a4180-65aa-42ec-a945-5fd21dec0549";
    await insertMessage({
      contactQid: "1",
      direction: "out",
      id: pendingId,
      sentAt: 2,
      status: "sending",
      text: "pending",
    });
    connectedPeers.mockReturnValue([PEER_CLI]);
    connectionEstablished?.({ connId: 11, peerId: PEER_CLI });
    firstAlice.resolve(phoneOnly);

    await vi.waitFor(async () =>
      expect(await getMessageById(pendingId)).toMatchObject({
        holderPeerId: PEER_CLI,
        status: "held",
      })
    );
    expect(aliceReads).toBeGreaterThan(1);
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

const bothCliAccount = (): RegistryAccount => ({
  ...aliceAccount,
  devices: [
    { deviceKey: phoneDeviceKey, peerId: PEER_ALICE },
    { deviceKey: cliDeviceKey, peerId: PEER_CLI },
    { deviceKey: otherCliDeviceKey, peerId: PEER_CLI_OTHER },
  ],
});

describe("multi-holder picker", () => {
  it("falls through a transient holder failure to the next holder", async () => {
    lookupHandle.mockImplementation((handle: string) =>
      Effect.succeed(handle === "alice" ? bothCliAccount() : bobAccount)
    );
    connectedPeers.mockReturnValue([PEER_CLI, PEER_CLI_OTHER]);
    handoff.mockImplementation(({ holderPeerId }) =>
      holderPeerId === PEER_CLI
        ? Promise.reject(new Error("offline"))
        : Promise.resolve()
    );
    await useP2pStore.getState().start();
    const contact = await getContactByQid("1");
    if (!contact) {
      throw new Error("Missing contact fixture");
    }
    const id = useP2pStore.getState().sendMessage(contact, "hello");
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({
        holderPeerId: PEER_CLI_OTHER,
        status: "held",
      })
    );
    expect(handoff.mock.calls.map((call) => call[0]?.holderPeerId)).toEqual([
      PEER_CLI,
      PEER_CLI_OTHER,
    ]);
  });

  it("stops after a permanent reject and does not try the next holder", async () => {
    lookupHandle.mockImplementation((handle: string) =>
      Effect.succeed(handle === "alice" ? bothCliAccount() : bobAccount)
    );
    connectedPeers.mockReturnValue([PEER_CLI, PEER_CLI_OTHER]);
    handoff.mockRejectedValue(new Error(HANDOFF_REJECTED_MESSAGE));
    await useP2pStore.getState().start();
    const contact = await getContactByQid("1");
    if (!contact) {
      throw new Error("Missing contact fixture");
    }
    const id = useP2pStore.getState().sendMessage(contact, "hello");
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({ status: "failed" })
    );
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(handoff).toHaveBeenCalledWith(
      expect.objectContaining({ holderPeerId: PEER_CLI })
    );
  });

  it("re-homes a held message whose holder left the roster", async () => {
    const unlinked = "12D3KooWunlinkedunlinkedunlinkedunlinkedunlinkedunlinked";
    const id = "c56a4180-65aa-42ec-a945-5fd21dec0701";
    await insertMessage({
      contactQid: "1",
      direction: "out",
      holderPeerId: unlinked,
      id,
      sentAt: 1,
      status: "held",
      text: "waiting",
    });
    poll.mockResolvedValue([]);
    await useP2pStore.getState().start();
    connectionEstablished?.({ connId: 2, peerId: PEER_CLI });
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({
        holderPeerId: PEER_CLI,
        status: "held",
      })
    );
  });

  it("leaves a held message on a linked holder that is offline", async () => {
    const id = "c56a4180-65aa-42ec-a945-5fd21dec0702";
    connectedPeers.mockReturnValue([]);
    await insertMessage({
      contactQid: "1",
      direction: "out",
      holderPeerId: PEER_CLI,
      id,
      sentAt: 1,
      status: "held",
      text: "waiting",
    });
    poll.mockResolvedValue([]);
    await useP2pStore.getState().start();
    await vi.waitFor(() => expect(poll).toHaveBeenCalled());
    await Effect.runPromise(Effect.sleep(50));
    expect(handoff).not.toHaveBeenCalled();
    expect(await getMessageById(id)).toMatchObject({
      holderPeerId: PEER_CLI,
      status: "held",
    });
  });
});

const bobInboxFrom = { fromHandle: "bob", fromQid: "1" } as const;

const inboxRecord = (
  messageId: string,
  text: string,
  from: { readonly fromHandle: string; readonly fromQid: string } = bobInboxFrom
) => ({
  frame: {
    fromHandle: from.fromHandle,
    id: messageId,
    sentAt: 10,
    text,
    v: 1 as const,
  },
  fromQid: from.fromQid,
  receivedAt: 11,
  v: 1 as const,
});

describe("inbox catch-up", () => {
  it("inserts received rows for a known contact and advances the cursor", async () => {
    const id = "c56a4180-65aa-42ec-a945-5fd21dec0601";
    const before = useP2pStore.getState().revision;
    catchup.mockImplementation(({ after }) =>
      Promise.resolve(
        after > 0
          ? []
          : [{ record: inboxRecord(id, "while you were out"), seq: 3 }]
      )
    );
    await useP2pStore.getState().start();
    await vi.waitFor(async () =>
      expect(await getMessageById(id, "1")).toMatchObject({
        direction: "in",
        status: "received",
        text: "while you were out",
      })
    );
    expect(await getHolderInboxCursor(PEER_CLI)).toBe(3);
    expect(useP2pStore.getState().revision).toBeGreaterThan(before);
  });

  it("ignores a duplicate id and still advances the cursor", async () => {
    const id = "c56a4180-65aa-42ec-a945-5fd21dec0602";
    await insertMessage({
      contactQid: "1",
      direction: "in",
      id,
      sentAt: 1,
      status: "received",
      text: "live",
    });
    catchup.mockImplementation(({ after }) =>
      Promise.resolve(
        after > 0 ? [] : [{ record: inboxRecord(id, "replay"), seq: 4 }]
      )
    );
    await useP2pStore.getState().start();
    await vi.waitFor(async () =>
      expect(await getHolderInboxCursor(PEER_CLI)).toBe(4)
    );
    expect(await getMessageById(id, "1")).toMatchObject({ text: "live" });
  });

  it("keeps a separate cursor for each holder", async () => {
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
    const first = "c56a4180-65aa-42ec-a945-5fd21dec0603";
    const second = "c56a4180-65aa-42ec-a945-5fd21dec0604";
    catchup.mockImplementation(({ after, holderPeerId }) => {
      if (after > 0) {
        return Promise.resolve([]);
      }
      if (holderPeerId === PEER_CLI) {
        return Promise.resolve([
          { record: inboxRecord(first, "from cli"), seq: 2 },
        ]);
      }
      return Promise.resolve([
        { record: inboxRecord(second, "from other"), seq: 8 },
      ]);
    });
    await useP2pStore.getState().start();
    await vi.waitFor(async () => {
      expect(await getMessageById(first, "1")).toMatchObject({
        text: "from cli",
      });
      expect(await getMessageById(second, "1")).toMatchObject({
        text: "from other",
      });
    });
    expect(await getHolderInboxCursor(PEER_CLI)).toBe(2);
    expect(await getHolderInboxCursor(PEER_CLI_OTHER)).toBe(8);
  });

  it("creates a contact for an unknown sender before inserting", async () => {
    const id = "c56a4180-65aa-42ec-a945-5fd21dec0605";
    const carolDeviceKey = `0x${"55".repeat(32)}`;
    const carolPeer = "12D3KooWcarolcarolcarolcarolcarolcarolcarolcarolcarolca";
    lookupQid.mockImplementation((qid: bigint) =>
      Effect.succeed(
        qid === 99n
          ? {
              ...bobAccount,
              deviceKey: carolDeviceKey,
              devices: [{ deviceKey: carolDeviceKey, peerId: carolPeer }],
              handle: "carol",
              peerId: carolPeer,
              qid: 99n,
            }
          : null
      )
    );
    catchup.mockImplementation(({ after }) =>
      Promise.resolve(
        after > 0
          ? []
          : [
              {
                record: inboxRecord(id, "first hello", {
                  fromHandle: "carol",
                  fromQid: "99",
                }),
                seq: 1,
              },
            ]
      )
    );
    await useP2pStore.getState().start();
    await vi.waitFor(async () =>
      expect(await getMessageById(id, "99")).toMatchObject({
        status: "received",
        text: "first hello",
      })
    );
    expect(await getContactByQid("99")).toMatchObject({
      deviceKey: carolDeviceKey,
      handle: "carol",
      peerId: carolPeer,
    });
    expect(await getHolderInboxCursor(PEER_CLI)).toBe(1);
  });

  it("skips an unknown sender whose handle was reassigned and advances the cursor", async () => {
    const id = "c56a4180-65aa-42ec-a945-5fd21dec0606";
    lookupQid.mockImplementation(() =>
      Effect.succeed({ ...bobAccount, handle: "mallory", qid: 99n })
    );
    catchup.mockImplementation(({ after }) =>
      Promise.resolve(
        after > 0
          ? []
          : [
              {
                record: inboxRecord(id, "stale", {
                  fromHandle: "carol",
                  fromQid: "99",
                }),
                seq: 6,
              },
            ]
      )
    );
    await useP2pStore.getState().start();
    await vi.waitFor(async () =>
      expect(await getHolderInboxCursor(PEER_CLI)).toBe(6)
    );
    expect(await getContactByQid("99")).toBeNull();
    expect(await getMessageById(id)).toBeNull();
  });
});
