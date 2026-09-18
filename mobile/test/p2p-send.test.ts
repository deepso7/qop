import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { encodeAck, MAX_CHAT_PAYLOAD_BYTES } from "@/lib/chat-wire";
import { performSend, withTimeout } from "@/lib/p2p-send";
import { createPeerSessions, PeerVerificationError } from "@/lib/p2p-sessions";
import { RegistryReaderError } from "@/lib/registry-core";
import type { RegistryAccount } from "@/lib/registry-core";

const PEER_BOB = "12D3KooWC7cDcNR4J3NC9y1gTkqafZKmnjCUvrRMxU2LMugGJGgy";

const id = "c56a4180-65aa-42ec-a945-5fd21dec0538";
const frame = {
  fromHandle: "alice",
  id,
  sentAt: 1_700_000_000_000,
  text: "hello",
  v: 1 as const,
};
const contact = { handle: "bob", peerId: "peer-stale", qid: "1" };
const account: RegistryAccount = {
  blockNumber: 1n,
  deviceKey: `0x${"22".repeat(32)}`,
  devices: [
    {
      deviceKey: `0x${"22".repeat(32)}`,
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

const makeEndpoint = (read: () => Promise<Uint8Array | undefined>) => {
  const lookupDeviceKey = vi.fn(
    (): Effect.Effect<RegistryAccount | null, RegistryReaderError> =>
      Effect.succeed(account)
  );
  const lookupHandle = vi.fn(
    (): Effect.Effect<RegistryAccount | null, RegistryReaderError> =>
      Effect.succeed(account)
  );
  const sessions = createPeerSessions({
    getContactByQid: () => Promise.resolve(null),
    lookupDeviceKey,
    lookupHandle,
    upsertContact: () => Promise.resolve(),
  });
  const stream = {
    closeWrite: vi.fn(),
    connId: 1,
    peerId: PEER_BOB,
    read: vi.fn(read),
    reset: vi.fn(),
    write: vi.fn(),
  };
  sessions.opened(stream);
  const endpoint = {
    connect: vi.fn().mockImplementation(() => Promise.resolve()),
    connectedPeers: vi.fn((): string[] => []),
    openStream: vi.fn().mockResolvedValue(stream),
    waitPeerReady: vi.fn(() => Promise.resolve({ peerId: PEER_BOB })),
  };
  return { endpoint, lookupDeviceKey, lookupHandle, sessions, stream };
};

const ackReader = (ackId: string) => {
  const chunks: (Uint8Array | undefined)[] = [
    encodeAck({ ack: ackId, v: 1 }),
    undefined,
  ];
  return () => Promise.resolve(chunks.shift());
};

// Promise.resolve(undefined) without tripping unicorn/no-useless-undefined.
const resolvedUndefined = async (): Promise<undefined> => {
  await Promise.resolve();
};

const expectRemainingTimeout = (timeoutMs: number, overall: number) => {
  expect(timeoutMs).toBeGreaterThan(0);
  expect(timeoutMs).toBeLessThanOrEqual(overall);
};

describe("performSend", () => {
  it("writes a frame and accepts a matching ack", async () => {
    const { endpoint, stream, sessions } = makeEndpoint(ackReader(id));

    await expect(
      performSend({ contact, endpoint, frame, sessions, timeoutMs: 50 })
    ).resolves.toBeUndefined();

    expect(endpoint.connect.mock.calls[0]?.[0]).toBe(PEER_BOB);
    expectRemainingTimeout(
      endpoint.connect.mock.calls[0]?.[1]?.timeoutMs ?? 0,
      50
    );
    expect(endpoint.openStream.mock.calls[0]?.[0]).toBe(PEER_BOB);
    expect(endpoint.openStream.mock.calls[0]?.[1]).toBe("/qop/chat/1");
    expectRemainingTimeout(
      endpoint.openStream.mock.calls[0]?.[2]?.timeoutMs ?? 0,
      50
    );
    expect(stream.write).toHaveBeenCalledOnce();
    expect(stream.closeWrite).toHaveBeenCalledOnce();
    expect(stream.reset).not.toHaveBeenCalled();
  });

  it("authorizes a stream when connectionEstablished was missed", async () => {
    const { endpoint, stream, sessions } = makeEndpoint(ackReader(id));
    sessions.closed(stream);

    await expect(
      performSend({ contact, endpoint, frame, sessions, timeoutMs: 50 })
    ).resolves.toBeUndefined();

    expect(stream.write).toHaveBeenCalledOnce();
    expect(stream.reset).not.toHaveBeenCalled();
  });

  it("waits for Identify before opening a chat stream", async () => {
    const { endpoint, stream, sessions } = makeEndpoint(ackReader(id));
    const order: string[] = [];
    endpoint.connect.mockImplementation(() => {
      order.push("connect");
      return Promise.resolve({ peerId: PEER_BOB });
    });
    endpoint.waitPeerReady = vi.fn(() => {
      order.push("ready");
      return Promise.resolve({ peerId: PEER_BOB });
    });
    endpoint.openStream.mockImplementation(() => {
      order.push("open");
      return Promise.resolve(stream);
    });

    await performSend({ contact, endpoint, frame, sessions, timeoutMs: 50 });
    expect(order).toEqual(["connect", "ready", "open"]);
  });

  it("waits for Identify even when the peer is already connected", async () => {
    const { endpoint, sessions } = makeEndpoint(ackReader(id));
    endpoint.connectedPeers.mockReturnValue([PEER_BOB]);

    await performSend({ contact, endpoint, frame, sessions, timeoutMs: 50 });
    expect(endpoint.connect).not.toHaveBeenCalled();
    expect(endpoint.waitPeerReady.mock.calls[0]?.[0]).toBe(PEER_BOB);
    expectRemainingTimeout(
      endpoint.waitPeerReady.mock.calls[0]?.[1]?.timeoutMs ?? 0,
      50
    );
  });

  it("does not open a stream when Identify never completes", async () => {
    const { endpoint, sessions, stream } = makeEndpoint(ackReader(id));
    endpoint.waitPeerReady = vi
      .fn()
      .mockRejectedValue(new Error("Timed out after 50 ms"));

    await expect(
      performSend({ contact, endpoint, frame, sessions, timeoutMs: 50 })
    ).rejects.toThrow("Timed out");
    expect(endpoint.openStream).not.toHaveBeenCalled();
    expect(stream.write).not.toHaveBeenCalled();
  });

  it("keeps sending on a verified connection during an RPC outage", async () => {
    const { endpoint, stream, sessions, lookupDeviceKey, lookupHandle } =
      makeEndpoint(ackReader(id));
    await performSend({ contact, endpoint, frame, sessions, timeoutMs: 50 });
    const deviceCalls = lookupDeviceKey.mock.calls.length;
    lookupDeviceKey.mockReturnValue(
      Effect.fail(new RegistryReaderError({ operation: "rpc" }))
    );
    lookupHandle.mockReturnValue(
      Effect.fail(new RegistryReaderError({ operation: "rpc" }))
    );
    endpoint.connectedPeers.mockReturnValue([PEER_BOB]);
    stream.read.mockImplementation(ackReader(id));
    await performSend({ contact, endpoint, frame, sessions, timeoutMs: 50 });
    expect(lookupDeviceKey).toHaveBeenCalledTimes(deviceCalls);
    expect(endpoint.connect).toHaveBeenCalledOnce();
    expect(stream.write).toHaveBeenCalledTimes(2);
  });

  it("rechecks a replacement connection before writing", async () => {
    const { endpoint, stream, sessions, lookupDeviceKey } = makeEndpoint(
      ackReader(id)
    );
    await Effect.runPromise(sessions.verify(stream, contact.handle));
    endpoint.openStream.mockImplementation(() => {
      sessions.closed(stream);
      stream.connId = 2;
      sessions.opened(stream);
      lookupDeviceKey.mockReturnValue(
        Effect.fail(new RegistryReaderError({ operation: "rpc" }))
      );
      return Promise.resolve(stream);
    });
    await expect(
      performSend({ contact, endpoint, frame, sessions, timeoutMs: 50 })
    ).rejects.toThrow();
    expect(stream.write).not.toHaveBeenCalled();
    expect(stream.reset).toHaveBeenCalledOnce();
  });

  it("rejects a stream authenticated as the wrong peer before writing", async () => {
    const { endpoint, stream, sessions } = makeEndpoint(ackReader(id));
    stream.peerId = "12D3KooWDGEF3VLEM7R3XWGJsqPCcSSjwRmuNw6JTQMVMNSSzwAz";
    sessions.opened(stream);
    await expect(
      performSend({ contact, endpoint, frame, sessions, timeoutMs: 50 })
    ).rejects.toThrow();
    expect(stream.write).not.toHaveBeenCalled();
    expect(stream.reset).toHaveBeenCalledOnce();
  });

  it("rejects a mismatched ack", async () => {
    const { endpoint, stream, sessions } = makeEndpoint(
      ackReader("9b2c40a8-705b-4f3b-a3cc-3d723711d851")
    );

    await expect(
      performSend({ contact, endpoint, frame, sessions, timeoutMs: 50 })
    ).rejects.toThrow("does not match");
    expect(stream.reset).toHaveBeenCalledOnce();
  });

  it("times out when the peer sends no ack", async () => {
    const unread = Promise.withResolvers<Uint8Array | undefined>();
    const { endpoint, stream, sessions } = makeEndpoint(() => unread.promise);

    await expect(
      performSend({ contact, endpoint, frame, sessions, timeoutMs: 5 })
    ).rejects.toThrow("Timed out");
    expect(stream.reset).toHaveBeenCalledOnce();
  });

  it("times out when registry lookup never resolves", async () => {
    const { endpoint, sessions, stream } = makeEndpoint(ackReader(id));
    const hung = Promise.withResolvers<never>();
    vi.spyOn(sessions, "recipientPeerIds").mockReturnValue(
      Effect.promise(() => hung.promise)
    );

    await expect(
      performSend({ contact, endpoint, frame, sessions, timeoutMs: 5 })
    ).rejects.toThrow("Timed out");
    expect(stream.write).not.toHaveBeenCalled();
    expect(stream.reset).not.toHaveBeenCalled();
  });

  it("cancels a late lookup before it can connect", async () => {
    const { endpoint, sessions } = makeEndpoint(ackReader(id));
    const pending = Promise.withResolvers<string[]>();
    let aborted = false;
    vi.spyOn(sessions, "recipientPeerIds").mockReturnValue(
      Effect.tryPromise({
        catch: () => new PeerVerificationError({ operation: "rpc" }),
        try: (signal) => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
          return pending.promise;
        },
      })
    );

    await expect(
      performSend({ contact, endpoint, frame, sessions, timeoutMs: 5 })
    ).rejects.toThrow("Timed out");
    expect(aborted).toBe(true);
    pending.resolve([PEER_BOB]);
    await Promise.resolve();
    expect(endpoint.connect).not.toHaveBeenCalled();
    expect(endpoint.openStream).not.toHaveBeenCalled();
  });

  it("does not open a stream after a late connection", async () => {
    const { endpoint, sessions, stream } = makeEndpoint(ackReader(id));
    const pending = Promise.withResolvers<undefined>();
    endpoint.connect.mockReturnValue(pending.promise);

    await expect(
      performSend({ contact, endpoint, frame, sessions, timeoutMs: 5 })
    ).rejects.toThrow("Timed out");
    pending.resolve(await resolvedUndefined());
    await Promise.resolve();
    expect(endpoint.openStream).not.toHaveBeenCalled();
    expect(stream.write).not.toHaveBeenCalled();
  });

  it("resets a stream that opens after the send deadline", async () => {
    const { endpoint, sessions, stream } = makeEndpoint(ackReader(id));
    const pending = Promise.withResolvers<typeof stream>();
    endpoint.openStream.mockReturnValue(pending.promise);

    await expect(
      performSend({ contact, endpoint, frame, sessions, timeoutMs: 5 })
    ).rejects.toThrow("Timed out");
    pending.resolve(stream);
    await vi.waitFor(() => expect(stream.reset).toHaveBeenCalledOnce());
    expect(stream.write).not.toHaveBeenCalled();
  });

  it("resets a stream that opens after an external cancellation", async () => {
    const { endpoint, sessions, stream } = makeEndpoint(ackReader(id));
    const pending = Promise.withResolvers<typeof stream>();
    const controller = new AbortController();
    endpoint.openStream.mockReturnValue(pending.promise);

    const sending = performSend({
      contact,
      endpoint,
      frame,
      sessions,
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    const rejected = sending.then(
      () => false,
      () => true
    );
    await vi.waitFor(() => expect(endpoint.openStream).toHaveBeenCalledOnce());
    controller.abort(new Error("endpoint stopped"));
    expect(await rejected).toBe(true);

    pending.resolve(stream);
    await vi.waitFor(() => expect(stream.reset).toHaveBeenCalledOnce());
    expect(stream.write).not.toHaveBeenCalled();
  });

  it("cancels verification after opening a stream", async () => {
    const { endpoint, lookupDeviceKey, sessions, stream } = makeEndpoint(
      ackReader(id)
    );
    const pending = Promise.withResolvers<RegistryAccount>();
    let aborted = false;
    lookupDeviceKey.mockReturnValueOnce(
      Effect.tryPromise({
        catch: () => new RegistryReaderError({ operation: "rpc" }),
        try: (signal) => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
          return pending.promise;
        },
      })
    );

    await expect(
      performSend({ contact, endpoint, frame, sessions, timeoutMs: 5 })
    ).rejects.toThrow("Timed out");
    expect(aborted).toBe(true);
    expect(stream.reset).toHaveBeenCalledOnce();
    expect(stream.write).not.toHaveBeenCalled();

    pending.resolve(account);
    await expect(
      Effect.runPromise(sessions.verify(stream, contact.handle))
    ).resolves.toMatchObject({ qid: contact.qid });
  });

  it("rejects an empty EOF close without an ack", async () => {
    const { endpoint, stream, sessions } = makeEndpoint(resolvedUndefined);

    await expect(
      performSend({ contact, endpoint, frame, sessions, timeoutMs: 50 })
    ).rejects.toThrow("Chat peer closed without an ack");
    expect(stream.reset).toHaveBeenCalledOnce();
  });

  it("rejects a streaming ack that exceeds the payload limit", async () => {
    const oversized = new Uint8Array(MAX_CHAT_PAYLOAD_BYTES + 1);
    const chunks: (Uint8Array | undefined)[] = [oversized, undefined];
    const { endpoint, stream, sessions } = makeEndpoint(() =>
      Promise.resolve(chunks.shift())
    );

    await expect(
      performSend({ contact, endpoint, frame, sessions, timeoutMs: 50 })
    ).rejects.toThrow("Chat ack exceeds 16 KB");
    expect(stream.reset).toHaveBeenCalledOnce();
  });

  it("falls through to the next roster device when the phone cannot be dialed", async () => {
    const peerCli = "12D3KooWDGEF3VLEM7R3XWGJsqPCcSSjwRmuNw6JTQMVMNSSzwAz";
    const cliDeviceKey = `0x${"33".repeat(32)}`;
    const { endpoint, lookupDeviceKey, lookupHandle, sessions, stream } =
      makeEndpoint(ackReader(id));
    const multiAccount: RegistryAccount = {
      ...account,
      devices: [
        { deviceKey: `0x${"22".repeat(32)}`, peerId: PEER_BOB },
        { deviceKey: cliDeviceKey, peerId: peerCli },
      ],
    };
    lookupDeviceKey.mockReturnValue(Effect.succeed(multiAccount));
    lookupHandle.mockReturnValue(Effect.succeed(multiAccount));
    sessions.closed(stream);
    stream.peerId = peerCli;
    endpoint.connect.mockImplementation((peerId: string) => {
      if (peerId === PEER_BOB) {
        return Promise.reject(new Error("phone offline"));
      }
      return Promise.resolve({ peerId });
    });

    await expect(
      performSend({ contact, endpoint, frame, sessions, timeoutMs: 50 })
    ).resolves.toBeUndefined();

    expect(endpoint.connect.mock.calls[0]?.[0]).toBe(PEER_BOB);
    expectRemainingTimeout(
      endpoint.connect.mock.calls[0]?.[1]?.timeoutMs ?? 0,
      50
    );
    expect(endpoint.connect.mock.calls[1]?.[0]).toBe(peerCli);
    expect(stream.write).toHaveBeenCalledOnce();
    expect(stream.reset).not.toHaveBeenCalled();
  });

  it("falls through when a live authorized phone cannot be dialed", async () => {
    const peerCli = "12D3KooWDGEF3VLEM7R3XWGJsqPCcSSjwRmuNw6JTQMVMNSSzwAz";
    const cliDeviceKey = `0x${"33".repeat(32)}`;
    const { endpoint, lookupDeviceKey, lookupHandle, sessions, stream } =
      makeEndpoint(ackReader(id));
    const multiAccount: RegistryAccount = {
      ...account,
      devices: [
        { deviceKey: `0x${"22".repeat(32)}`, peerId: PEER_BOB },
        { deviceKey: cliDeviceKey, peerId: peerCli },
      ],
    };
    lookupDeviceKey.mockReturnValue(Effect.succeed(multiAccount));
    lookupHandle.mockReturnValue(Effect.succeed(multiAccount));
    await Effect.runPromise(sessions.verify(stream, contact.handle));
    stream.peerId = peerCli;
    endpoint.connect.mockImplementation((peerId: string) => {
      if (peerId === PEER_BOB) {
        return Promise.reject(new Error("phone offline"));
      }
      return Promise.resolve({ peerId });
    });

    await expect(
      performSend({ contact, endpoint, frame, sessions, timeoutMs: 50 })
    ).resolves.toBeUndefined();

    expect(endpoint.connect.mock.calls[0]?.[0]).toBe(PEER_BOB);
    expectRemainingTimeout(
      endpoint.connect.mock.calls[0]?.[1]?.timeoutMs ?? 0,
      50
    );
    expect(endpoint.connect.mock.calls[1]?.[0]).toBe(peerCli);
    expect(stream.write).toHaveBeenCalledOnce();
  });

  it("passes remaining send budget to the next roster candidate", async () => {
    const peerCli = "12D3KooWDGEF3VLEM7R3XWGJsqPCcSSjwRmuNw6JTQMVMNSSzwAz";
    const cliDeviceKey = `0x${"33".repeat(32)}`;
    const { endpoint, lookupDeviceKey, lookupHandle, sessions, stream } =
      makeEndpoint(ackReader(id));
    const multiAccount: RegistryAccount = {
      ...account,
      devices: [
        { deviceKey: `0x${"22".repeat(32)}`, peerId: PEER_BOB },
        { deviceKey: cliDeviceKey, peerId: peerCli },
      ],
    };
    lookupDeviceKey.mockReturnValue(Effect.succeed(multiAccount));
    lookupHandle.mockReturnValue(Effect.succeed(multiAccount));
    sessions.closed(stream);
    stream.peerId = peerCli;
    endpoint.connect.mockImplementation(async (peerId: string) => {
      if (peerId === PEER_BOB) {
        await Effect.runPromise(Effect.sleep(20));
        throw new Error("phone offline");
      }
      return { peerId };
    });

    await expect(
      performSend({ contact, endpoint, frame, sessions, timeoutMs: 80 })
    ).resolves.toBeUndefined();
    const secondTimeout = endpoint.connect.mock.calls[1]?.[1]?.timeoutMs;
    expect(secondTimeout).toBeGreaterThan(0);
    expect(secondTimeout).toBeLessThan(80);
    expect(stream.write).toHaveBeenCalledOnce();
  });

  it("does not give each roster candidate a fresh timeout", async () => {
    const peerCli = "12D3KooWDGEF3VLEM7R3XWGJsqPCcSSjwRmuNw6JTQMVMNSSzwAz";
    const cliDeviceKey = `0x${"33".repeat(32)}`;
    const { endpoint, lookupDeviceKey, lookupHandle, sessions, stream } =
      makeEndpoint(ackReader(id));
    const multiAccount: RegistryAccount = {
      ...account,
      devices: [
        { deviceKey: `0x${"22".repeat(32)}`, peerId: PEER_BOB },
        { deviceKey: cliDeviceKey, peerId: peerCli },
      ],
    };
    lookupDeviceKey.mockReturnValue(Effect.succeed(multiAccount));
    lookupHandle.mockReturnValue(Effect.succeed(multiAccount));
    sessions.closed(stream);
    const hung = Promise.withResolvers<undefined>();
    endpoint.connect.mockImplementation(() => hung.promise);

    const startedAt = Date.now();
    await expect(
      performSend({ contact, endpoint, frame, sessions, timeoutMs: 80 })
    ).rejects.toThrow("Timed out");
    expect(Date.now() - startedAt).toBeLessThan(140);
    const timeouts = endpoint.connect.mock.calls.map(
      ([, options]) => options?.timeoutMs
    );
    expect(timeouts[0]).toBeLessThanOrEqual(80);
    expect(timeouts.slice(1).every((timeoutMs) => timeoutMs < 80)).toBe(true);
    hung.resolve(await resolvedUndefined());
  });

  it("does not fall through after writing a frame", async () => {
    const peerCli = "12D3KooWDGEF3VLEM7R3XWGJsqPCcSSjwRmuNw6JTQMVMNSSzwAz";
    const cliDeviceKey = `0x${"33".repeat(32)}`;
    const { endpoint, lookupDeviceKey, lookupHandle, sessions, stream } =
      makeEndpoint(ackReader("9b2c40a8-705b-4f3b-a3cc-3d723711d851"));
    const multiAccount: RegistryAccount = {
      ...account,
      devices: [
        { deviceKey: `0x${"22".repeat(32)}`, peerId: PEER_BOB },
        { deviceKey: cliDeviceKey, peerId: peerCli },
      ],
    };
    lookupDeviceKey.mockReturnValue(Effect.succeed(multiAccount));
    lookupHandle.mockReturnValue(Effect.succeed(multiAccount));

    await expect(
      performSend({ contact, endpoint, frame, sessions, timeoutMs: 50 })
    ).rejects.toThrow("does not match");
    expect(endpoint.connect.mock.calls.map(([peerId]) => peerId)).toEqual([
      PEER_BOB,
    ]);
    expect(stream.write).toHaveBeenCalledOnce();
  });
});

describe("withTimeout", () => {
  it("rejects after the deadline", async () => {
    vi.useFakeTimers();
    try {
      const pending = Promise.withResolvers<never>();
      const result = withTimeout(pending.promise, 100);
      const assertion = expect(result).rejects.toThrow("Timed out");

      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
