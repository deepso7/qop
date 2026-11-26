import { setTimeout as sleep } from "node:timers/promises";

import {
  deviceKeyBytesFromPeerId,
  deviceKeyFromEd25519SecretKey,
  deviceKeyFromPeerId,
  Hex32,
  PeerId,
} from "@qop/identity";
import {
  decodeMailboxRequestV1,
  encodeBase64,
  encodeMailboxResponseV1,
  MAILBOX_PROTOCOL,
} from "@qop/protocol";
import type { MailboxRequest } from "@qop/protocol";
import { Effect, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CHAT_PROTOCOL, createChatCipher, encodeAck } from "@/lib/chat-wire";
import {
  advanceMessageStatus,
  deleteAll,
  getContactByQid,
  getMessageById,
  insertMessage,
  listMessages,
  recordMessageRetry,
  upsertContact,
} from "@/lib/db";
import type { performSend } from "@/lib/p2p-send";
import { performSend as sendToPeer } from "@/lib/p2p-send";
import { createP2pStore } from "@/lib/p2p-store-core";
import type { P2pEndpoint } from "@/lib/p2p-store-core";
import type {
  lookupDeviceKey as LookupDeviceKey,
  lookupHandle as LookupHandle,
} from "@/lib/registry";
import type { RegistryAccount } from "@/lib/registry-core";

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
  it("wakes a connected contact in O(1) without looking up unrelated queued contacts", async () => {
    const ids = new Map<string, string>();

    const seed = async (qid: string) => {
      if (qid !== "1") {
        await upsertContact({
          createdAt: 1,
          deviceKey: `0x${qid.padStart(64, "0")}`,
          handle: `contact${qid}`,
          owner: bobAccount.owner,
          peerId: `peer-${qid}`,
          qid,
        });
      }

      const id = crypto.randomUUID();
      ids.set(qid, id);
      await insertMessage({
        contactQid: qid,
        direction: "out",
        id,
        sentAt: 1,
        status: "queued",
        text: "waiting",
      });

      await Effect.runPromise(
        Effect.forEach(
          [0, 1, 2, 3, 4, 5],
          () => Effect.promise(() => recordMessageRetry(id, qid)),
          { concurrency: 1 }
        )
      );
    };

    await Promise.all(["2", "3", "4", "5", "6", "7", "8", "9"].map(seed));
    await seed("1");

    const bobMessageId = ids.get("1") ?? "";

    lookupHandle.mockImplementation((handle) =>
      Effect.succeed(handle === "bob" ? bobAccount : null)
    );
    await useP2pStore.getState().start();
    lookupHandle.mockClear();

    connectionEstablished?.({ connId: 7, peerId: PEER_BOB });
    await vi.waitFor(async () =>
      expect(await getMessageById(bobMessageId, "1")).toMatchObject({
        status: "sent",
      })
    );
    expect(send).toHaveBeenCalledOnce();
    // No O(N) lookupHandle scan across the other 8 queued contacts.
    expect(lookupHandle).not.toHaveBeenCalled();
  });

  it("wakes a contact connecting from a secondary device via one device-key lookup", async () => {
    const secondaryPeer =
      "12D3KooWDGEF3VLEM7R3XWGJsqPCcSSjwRmuNw6JTQMVMNSSzwAz";

    const secondaryKey = Schema.encodeSync(Hex32)(
      Effect.runSync(
        deviceKeyFromPeerId(Schema.decodeUnknownSync(PeerId)(secondaryPeer))
      )
    );

    const multiDeviceBob: RegistryAccount = {
      ...bobAccount,
      devices: [
        { deviceKey: bobDeviceKey, peerId: PEER_BOB },
        { deviceKey: secondaryKey, peerId: secondaryPeer },
      ],
    };

    const id = crypto.randomUUID();
    await insertMessage({
      contactQid: "1",
      direction: "out",
      id,
      sentAt: 1,
      status: "queued",
      text: "waiting for desktop",
    });
    await recordMessageRetry(id, "1");

    lookupDeviceKey.mockReturnValue(Effect.succeed(multiDeviceBob));
    await useP2pStore.getState().start();
    lookupHandle.mockClear();

    connectionEstablished?.({ connId: 8, peerId: secondaryPeer });
    await vi.waitFor(async () =>
      expect(await getMessageById(id, "1")).toMatchObject({
        status: "sent",
      })
    );
    expect(send).toHaveBeenCalledOnce();
    expect(lookupHandle).not.toHaveBeenCalled();
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
        attempts: 1,
        status: "queued",
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

  it("retries immediately when the peer connects while an offline attempt is still in flight", async () => {
    const firstAttempt = Promise.withResolvers<undefined>();
    send.mockReturnValueOnce(firstAttempt.promise).mockResolvedValueOnce();
    await useP2pStore.getState().start();
    const contact = await getContactByQid("1");

    if (!contact) {
      throw new Error("Missing contact");
    }

    const id = useP2pStore.getState().sendMessage(contact, "in-flight wake");
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());

    // Bob comes online before the first attempt times out.
    connectionEstablished?.({ connId: 7, peerId: PEER_BOB });
    await vi.waitFor(() => expect(lookupDeviceKey).toHaveBeenCalled());

    firstAttempt.reject(new Error("first dial timed out"));
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({ status: "sent" })
    );
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keeps retry backoff when an outbox dial connects then fails before ack", async () => {
    connect.mockImplementation(() => {
      connectionEstablished?.({ connId: 7, peerId: PEER_BOB });

      return Promise.resolve({
        connectId: 1,
        path: { kind: "direct" },
        peerId: PEER_BOB,
      });
    });

    send.mockImplementationOnce(async ({ endpoint }) => {
      await endpoint.connect(PEER_BOB);
      await vi.waitFor(() => expect(lookupDeviceKey).toHaveBeenCalled());
      throw new Error("peer disconnected before ack");
    });

    await useP2pStore.getState().start();
    const contact = await getContactByQid("1");

    if (!contact) {
      throw new Error("Missing contact");
    }

    const id = useP2pStore.getState().sendMessage(contact, "drop before ack");
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({
        attempts: 1,
        status: "queued",
      })
    );

    const row = await getMessageById(id);
    expect(row?.nextAttemptAt).toBeGreaterThan(Date.now());
    expect(send).toHaveBeenCalledOnce();
  });

  it("preserves dial backoff even when retry write finishes before peer verification resolves", async () => {
    const verifyGate = Promise.withResolvers<RegistryAccount>();
    lookupDeviceKey.mockReturnValueOnce(
      Effect.promise(() => verifyGate.promise)
    );

    connect.mockImplementation(() => {
      connectionEstablished?.({ connId: 7, peerId: PEER_BOB });

      return Promise.resolve({
        connectId: 1,
        path: { kind: "direct" },
        peerId: PEER_BOB,
      });
    });

    send.mockImplementationOnce(async ({ endpoint }) => {
      await endpoint.connect(PEER_BOB);
      throw new Error("peer disconnected before ack");
    });

    await useP2pStore.getState().start();
    const contact = await getContactByQid("1");

    if (!contact) {
      throw new Error("Missing contact");
    }

    const id = useP2pStore.getState().sendMessage(contact, "slow verify");

    // Retry write commits and releases dial tracking before verify resolves.
    await vi.waitFor(async () =>
      expect(await getMessageById(id)).toMatchObject({
        attempts: 1,
        status: "queued",
      })
    );

    const beforeVerify = await getMessageById(id);
    expect(beforeVerify?.nextAttemptAt).toBeGreaterThan(Date.now());

    // Now verification finishes; it must NOT clear the originating row's deadline.
    verifyGate.resolve(bobAccount);
    await sleep(30);

    const afterVerify = await getMessageById(id);
    expect(afterVerify?.nextAttemptAt).toBe(beforeVerify?.nextAttemptAt);
    expect(send).toHaveBeenCalledOnce();
  });

  it("caches unknown-peer lookup misses so repeated stranger connects do not spam registry reads", async () => {
    send.mockRejectedValue(new Error("offline"));
    lookupDeviceKey.mockReturnValue(Effect.succeed(null));

    await useP2pStore.getState().start();
    const contact = await getContactByQid("1");

    if (!contact) {
      throw new Error("Missing contact fixture");
    }

    useP2pStore.getState().sendMessage(contact, "queued for bob");
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    lookupDeviceKey.mockClear();

    for (let i = 0; i < 5; i += 1) {
      connectionEstablished?.({ connId: 20 + i, peerId: PEER_ALICE });
    }

    await vi.waitFor(() => expect(lookupDeviceKey).toHaveBeenCalledOnce());
    await sleep(30);

    for (let i = 0; i < 5; i += 1) {
      connectionEstablished?.({ connId: 30 + i, peerId: PEER_ALICE });
    }

    await sleep(30);
    expect(lookupDeviceKey).toHaveBeenCalledOnce();
  });

  it("caches resolved secondary devices without blocking later wakes once messages are queued", async () => {
    const secondaryPeer = PEER_ALICE;

    const secondaryKey = Effect.runSync(
      Schema.decodeUnknownEffect(PeerId)(secondaryPeer).pipe(
        Effect.flatMap(deviceKeyFromPeerId),
        Effect.flatMap((key) => Schema.encodeEffect(Hex32)(key))
      )
    );

    const bobWithSecondary: RegistryAccount = {
      ...bobAccount,
      devices: [
        ...bobAccount.devices,
        { deviceKey: secondaryKey, peerId: secondaryPeer },
      ],
    };

    const carolContact = {
      createdAt: 2,
      deviceKey: `0x${"33".repeat(32)}`,
      handle: "carol",
      owner: "0x0000000000000000000000000000000000000003",
      peerId: "12D3KooWbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      qid: "2",
    };

    await upsertContact(carolContact);
    send.mockRejectedValue(new Error("offline"));
    lookupDeviceKey.mockReturnValue(Effect.succeed(bobWithSecondary));
    lookupHandle.mockReturnValue(Effect.succeed(bobWithSecondary));

    await useP2pStore.getState().start();
    const bobContact = await getContactByQid("1");
    const carol = await getContactByQid("2");

    if (!bobContact || !carol) {
      throw new Error("Missing contact fixtures");
    }

    // Carol has a queued message while Bob has none; Bob's secondary connects.
    useP2pStore.getState().sendMessage(carol, "for carol");
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    connectionEstablished?.({ connId: 40, peerId: secondaryPeer });
    await vi.waitFor(() => expect(lookupDeviceKey).toHaveBeenCalledOnce());

    // Now Bob gets a queued message in backoff, and Bob's secondary reconnects.
    const bobId = useP2pStore.getState().sendMessage(bobContact, "for bob");
    await vi.waitFor(async () =>
      expect(await getMessageById(bobId, "1")).toMatchObject({
        attempts: 1,
        status: "queued",
      })
    );

    send.mockResolvedValue();
    connectionEstablished?.({ connId: 41, peerId: secondaryPeer });
    await vi.waitFor(async () =>
      expect(await getMessageById(bobId, "1")).toMatchObject({ status: "sent" })
    );
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

  it("resets backoff attempts and bumps revision on manual retry of a failed message", async () => {
    const id = crypto.randomUUID();
    await insertMessage({
      contactQid: "1",
      direction: "out",
      id,
      sentAt: 1,
      status: "queued",
      text: "manual retry",
    });
    await recordMessageRetry(id, "1");
    await recordMessageRetry(id, "1");
    await advanceMessageStatus(id, "failed", "1");

    send.mockRejectedValueOnce(new Error("still offline"));
    await useP2pStore.getState().start();
    const before = useP2pStore.getState().revision;

    await useP2pStore.getState().retryMessage(id, "1");
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await vi.waitFor(async () =>
      expect(await getMessageById(id, "1")).toMatchObject({
        attempts: 1,
        status: "queued",
      })
    );
    expect(useP2pStore.getState().revision).toBeGreaterThan(before);
  });
});

describe("interrupted sends", () => {
  it("delivers a persisted queued message when starting a new endpoint", async () => {
    await insertMessage({
      contactQid: "1",
      direction: "out",
      id: "c56a4180-65aa-42ec-a945-5fd21dec0572",
      sentAt: 1,
      status: "queued",
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

  it("keeps an interrupted send queued before stop finishes", async () => {
    const { id, pending } = await beginSend();
    const stopped = useP2pStore.getState().stop();
    pending.reject(new Error("connection closed"));
    await stopped;
    expect(await getMessageById(id)).toMatchObject({ status: "queued" });
  });

  it("tears down and keeps interrupted sends queued on driverFailed", async () => {
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
    const retryPending = Promise.withResolvers<undefined>();
    send.mockReturnValueOnce(retryPending.promise);
    await useP2pStore.getState().start();

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

    const abandoned = Promise.withResolvers<undefined>();
    let cancelled = false;
    send.mockImplementationOnce(({ signal }) => {
      signal?.addEventListener("abort", () => {
        cancelled = true;
      });

      return abandoned.promise;
    });

    await useP2pStore.getState().start();
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

describe("mailbox fallback and drain", () => {
  const PEER_MAILBOX = "12D3KooWMailboxTestPeerId11111111111111111111111111";

  const makeMailboxStream = (
    onRequest: (request: MailboxRequest) => Uint8Array
  ) => {
    const written: Uint8Array[] = [];
    let replyChunks: Uint8Array[] = [];
    let readIndex = 0;

    return {
      closeWrite: () => {
        const total = written.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const body = new Uint8Array(total);
        let offset = 0;

        for (const chunk of written) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }

        const request = Effect.runSync(decodeMailboxRequestV1(body));
        replyChunks = [onRequest(request)];
      },
      connId: 99,
      peerId: PEER_MAILBOX,
      protocolId: MAILBOX_PROTOCOL,
      read: () => {
        const chunk = replyChunks[readIndex];
        readIndex += 1;

        return Promise.resolve(chunk);
      },
      reset: vi.fn(),
      write: (data: Uint8Array) => {
        written.push(data);

        return Promise.resolve();
      },
    };
  };

  it("deposits to the configured mailbox inside the outbox when direct delivery fails", async () => {
    const depositedIds: string[] = [];
    let mailboxUnavailable = false;

    const directSend = vi
      .fn<typeof performSend>()
      .mockRejectedValue(new Error("Recipient offline"));

    const store = createP2pStore({
      createEndpoint: () => ({
        bindAppState: () => () => {},
        endpoint: {
          activeReservation: () => {},
          close: () => Promise.resolve(closeReport),
          connect: () =>
            Promise.resolve({
              connectId: 1,
              path: { kind: "direct" },
              peerId: PEER_MAILBOX,
            }),
          connectedPeers: () => [PEER_MAILBOX],
          disconnect: vi.fn(),
          isPeerReady: () => true,
          on: () => () => {},
          onClose: () => () => {},
          openStream: () =>
            // SAFETY: Test double implements the Stream methods used by mailbox I/O.
            Promise.resolve(
              makeMailboxStream((request) => {
                if (request.type === "fetch") {
                  return Effect.runSync(
                    encodeMailboxResponseV1({
                      hasMore: false,
                      items: [],
                      type: "messages",
                      v: 1,
                    })
                  );
                }

                if (request.type === "deposit") {
                  if (mailboxUnavailable) {
                    return Effect.runSync(
                      encodeMailboxResponseV1({
                        reason: "unavailable",
                        type: "error",
                        v: 1,
                      })
                    );
                  }

                  const ids = request.items.map((item) => item.id);
                  depositedIds.push(...ids);

                  return Effect.runSync(
                    encodeMailboxResponseV1({
                      items: request.items.map((item) => ({
                        id: item.id,
                        recipientDeviceKey: item.recipientDeviceKey,
                      })),
                      type: "deposited",
                      v: 1,
                    })
                  );
                }

                return Effect.runSync(
                  encodeMailboxResponseV1({ count: 0, type: "acked", v: 1 })
                );
              }) as never
            ),
          path: () => {},
          waitPeerReady: () =>
            Promise.resolve({
              peerId: PEER_MAILBOX,
              protocols: [MAILBOX_PROTOCOL],
            }),
        },
      }),
      getIdentityHandle: () => "alice",
      listActiveDevices: () =>
        Effect.succeed([{ deviceKey: bobDeviceKey, peerId: PEER_BOB }]),
      loadDeviceSecretKey: () => Effect.succeed(new Uint8Array(32).fill(2)),
      lookupDeviceKey,
      lookupHandle,
      mailboxes: [
        {
          addr: `/ip4/127.0.0.1/udp/4001/quic-v1/p2p/${PEER_MAILBOX}`,
          peerId: PEER_MAILBOX,
        },
      ],
      performSend: directSend,
      randomUUID: () => crypto.randomUUID(),
    });

    try {
      await store.getState().start();
      const contact = await getContactByQid("1");

      if (!contact) {
        throw new Error("Missing contact fixture");
      }

      const id = store.getState().sendMessage(contact, "offline via mailbox");

      await vi.waitFor(async () => {
        const stored = await getMessageById(id);
        expect(stored?.status).toBe("sent");
      });
      expect(depositedIds).toContain(id);

      mailboxUnavailable = true;

      const retryId = store
        .getState()
        .sendMessage(contact, "retry until mailbox recovers");

      await vi.waitFor(async () => {
        const stored = await getMessageById(retryId);
        expect(stored?.status).toBe("queued");
        expect(stored?.attempts).toBeGreaterThanOrEqual(1);
      });

      mailboxUnavailable = false;
      await store.getState().retryMessage(retryId, contact.qid);

      await vi.waitFor(async () => {
        const stored = await getMessageById(retryId);
        expect(stored?.status).toBe("sent");
      });
      expect(depositedIds).toContain(retryId);
    } finally {
      await store.getState().stop();
    }
  });

  it("drains mailbox on app resume without clobbering existing contact peerId", async () => {
    const bobSecret = new Uint8Array(32).fill(7);
    const aliceSecret = new Uint8Array(32).fill(2);
    const bobPub = Effect.runSync(deviceKeyFromEd25519SecretKey(bobSecret));
    const bobKeyHex = Effect.runSync(Schema.encodeEffect(Hex32)(bobPub));
    const alicePub = Effect.runSync(deviceKeyFromEd25519SecretKey(aliceSecret));
    const msgId = "c56a4180-65aa-42ec-a945-5fd21dec0538";

    const sealed = encodeBase64(
      await createChatCipher(bobSecret).seal(
        {
          fromHandle: "bob",
          id: msgId,
          sentAt: 1_700_000_000_000,
          text: "hello from mailbox",
          v: 1,
        },
        alicePub
      )
    );

    const pendingItems: {
      readonly envelope: string;
      readonly id: string;
      readonly senderDeviceKey: string;
      readonly seq: number;
      readonly storedAt: number;
    }[] = [];

    const ackedSeqs: number[] = [];
    let resumeHandler: (() => void) | undefined;

    const store = createP2pStore({
      createEndpoint: () => ({
        bindAppState: () => () => {},
        endpoint: {
          activeReservation: () => {},
          close: () => Promise.resolve(closeReport),
          connect: () =>
            Promise.resolve({
              connectId: 1,
              path: { kind: "direct" },
              peerId: PEER_MAILBOX,
            }),
          connectedPeers: () => [PEER_MAILBOX],
          disconnect: vi.fn(),
          isPeerReady: () => true,
          on: () => () => {},
          onClose: () => () => {},
          openStream: () =>
            // SAFETY: Test double implements the Stream methods used by mailbox I/O.
            Promise.resolve(
              makeMailboxStream((request) => {
                if (request.type === "fetch") {
                  return Effect.runSync(
                    encodeMailboxResponseV1({
                      hasMore: false,
                      items: [...pendingItems],
                      type: "messages",
                      v: 1,
                    })
                  );
                }

                if (request.type === "ack") {
                  ackedSeqs.push(...request.seqs);
                  pendingItems.length = 0;

                  return Effect.runSync(
                    encodeMailboxResponseV1({
                      count: request.seqs.length,
                      type: "acked",
                      v: 1,
                    })
                  );
                }

                return Effect.runSync(
                  encodeMailboxResponseV1({
                    reason: "invalid",
                    type: "error",
                    v: 1,
                  })
                );
              }) as never
            ),
          path: () => {},
          waitPeerReady: () =>
            Promise.resolve({
              peerId: PEER_MAILBOX,
              protocols: [MAILBOX_PROTOCOL],
            }),
        },
      }),
      getIdentityHandle: () => "alice",
      loadDeviceSecretKey: () => Effect.succeed(aliceSecret),
      lookupDeviceKey: () =>
        Effect.succeed({
          blockNumber: 1n,
          deviceKey: bobKeyHex,
          devices: [{ deviceKey: bobKeyHex, peerId: PEER_BOB }],
          freshness: "fresh" as const,
          handle: "bob",
          nonce: 0n,
          owner: "0x2222222222222222222222222222222222222222",
          ownerVersion: 0,
          peerId: PEER_BOB,
          qid: 1n,
          registeredAt: 1_700_000_000n,
        }),
      lookupHandle,
      mailboxes: [
        {
          addr: `/ip4/127.0.0.1/udp/4001/quic-v1/p2p/${PEER_MAILBOX}`,
          peerId: PEER_MAILBOX,
        },
      ],
      performSend: vi.fn<typeof performSend>(),
      randomUUID: () => crypto.randomUUID(),
      subscribeAppResume: (handler) => {
        resumeHandler = handler;

        return () => {
          resumeHandler = undefined;
        };
      },
    });

    try {
      await store.getState().start();
      const contactBefore = await getContactByQid("1");
      expect(contactBefore?.peerId).toBe(PEER_BOB);

      // Enqueue message while app is "backgrounded", then trigger app resume.
      pendingItems.push({
        envelope: sealed,
        id: msgId,
        senderDeviceKey: bobKeyHex,
        seq: 1,
        storedAt: 1_700_000_000_000,
      });

      resumeHandler?.();

      await vi.waitFor(async () => {
        const stored = await getMessageById(msgId);
        expect(stored?.text).toBe("hello from mailbox");
      });

      expect(ackedSeqs).toEqual([1]);

      // Existing contact peerId must NOT be clobbered to "".
      const contactAfter = await getContactByQid("1");
      expect(contactAfter?.peerId).toBe(PEER_BOB);
    } finally {
      await store.getState().stop();
    }
  });

  it("bumps store revision when a drained message is saved even if the ACK fails", async () => {
    const bobSecret = new Uint8Array(32).fill(7);
    const aliceSecret = new Uint8Array(32).fill(2);
    const bobPub = Effect.runSync(deviceKeyFromEd25519SecretKey(bobSecret));
    const bobKeyHex = Effect.runSync(Schema.encodeEffect(Hex32)(bobPub));
    const alicePub = Effect.runSync(deviceKeyFromEd25519SecretKey(aliceSecret));
    const msgId = "d56a4180-65aa-42ec-a945-5fd21dec0538";

    const sealed = encodeBase64(
      await createChatCipher(bobSecret).seal(
        {
          fromHandle: "bob",
          id: msgId,
          sentAt: 1_700_000_000_000,
          text: "saved before ack error",
          v: 1,
        },
        alicePub
      )
    );

    const store = createP2pStore({
      createEndpoint: () => ({
        bindAppState: () => () => {},
        endpoint: {
          activeReservation: () => {},
          close: () => Promise.resolve(closeReport),
          connect: () =>
            Promise.resolve({
              connectId: 1,
              path: { kind: "direct" },
              peerId: PEER_MAILBOX,
            }),
          connectedPeers: () => [PEER_MAILBOX],
          disconnect: vi.fn(),
          isPeerReady: () => true,
          on: () => () => {},
          onClose: () => () => {},
          openStream: () =>
            // SAFETY: Test double implements the Stream methods used by mailbox I/O.
            Promise.resolve(
              makeMailboxStream((request) => {
                if (request.type === "fetch") {
                  return Effect.runSync(
                    encodeMailboxResponseV1({
                      hasMore: false,
                      items: [
                        {
                          envelope: sealed,
                          id: msgId,
                          senderDeviceKey: bobKeyHex,
                          seq: 1,
                          storedAt: 1_700_000_000_000,
                        },
                      ],
                      type: "messages",
                      v: 1,
                    })
                  );
                }

                return Effect.runSync(
                  encodeMailboxResponseV1({
                    reason: "unavailable",
                    type: "error",
                    v: 1,
                  })
                );
              }) as never
            ),
          path: () => {},
          waitPeerReady: () =>
            Promise.resolve({
              peerId: PEER_MAILBOX,
              protocols: [MAILBOX_PROTOCOL],
            }),
        },
      }),
      getIdentityHandle: () => "alice",
      loadDeviceSecretKey: () => Effect.succeed(aliceSecret),
      lookupDeviceKey: () =>
        Effect.succeed({
          blockNumber: 1n,
          deviceKey: bobKeyHex,
          devices: [{ deviceKey: bobKeyHex, peerId: PEER_BOB }],
          freshness: "fresh" as const,
          handle: "bob",
          nonce: 0n,
          owner: "0x2222222222222222222222222222222222222222",
          ownerVersion: 0,
          peerId: PEER_BOB,
          qid: 1n,
          registeredAt: 1_700_000_000n,
        }),
      lookupHandle,
      mailboxes: [
        {
          addr: `/ip4/127.0.0.1/udp/4001/quic-v1/p2p/${PEER_MAILBOX}`,
          peerId: PEER_MAILBOX,
        },
      ],
      performSend: vi.fn<typeof performSend>(),
      randomUUID: () => crypto.randomUUID(),
    });

    try {
      const initialRevision = store.getState().revision;
      await store.getState().start();

      await vi.waitFor(async () => {
        const stored = await getMessageById(msgId);
        expect(stored?.text).toBe("saved before ack error");
      });

      await vi.waitFor(() => {
        expect(store.getState().revision).toBeGreaterThan(initialRevision);
      });
    } finally {
      await store.getState().stop();
    }
  });
});
