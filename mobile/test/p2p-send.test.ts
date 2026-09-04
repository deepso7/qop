import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { encodeAck } from "@/lib/chat-wire";
import { performSend, withTimeout } from "@/lib/p2p-send";
import { createPeerSessions } from "@/lib/p2p-sessions";
import { RegistryReaderError } from "@/lib/registry-core";
import type { RegistryAccount } from "@/lib/registry-core";

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
  deviceKey: `0x${"22".repeat(32)}`,
  handle: "bob",
  owner: "0x0000000000000000000000000000000000000001",
  ownerVersion: 0,
  peerId: "peer-bob",
  qid: 1n,
  registeredAt: 1n,
};

const makeEndpoint = (read: () => Promise<Uint8Array | undefined>) => {
  const lookupHandle = vi.fn(
    (): Effect.Effect<RegistryAccount | null, RegistryReaderError> =>
      Effect.succeed(account)
  );
  const sessions = createPeerSessions({
    getContactByQid: () => Promise.resolve(null),
    lookupHandle,
    upsertContact: () => Promise.resolve(),
  });
  const stream = {
    closeWrite: vi.fn(),
    connId: 1,
    peerId: account.peerId,
    read: vi.fn(read),
    reset: vi.fn(),
    write: vi.fn(),
  };
  sessions.opened(stream);
  const endpoint = {
    connect: vi.fn().mockImplementation(() => Promise.resolve()),
    connectedPeers: vi.fn((): string[] => []),
    openStream: vi.fn().mockResolvedValue(stream),
  };
  return { endpoint, lookupHandle, sessions, stream };
};

const ackReader = (ackId: string) => {
  const chunks: (Uint8Array | undefined)[] = [
    encodeAck({ ack: ackId, v: 1 }),
    undefined,
  ];
  return () => Promise.resolve(chunks.shift());
};

describe("performSend", () => {
  it("writes a frame and accepts a matching ack", async () => {
    const { endpoint, stream, sessions } = makeEndpoint(ackReader(id));

    await expect(
      performSend({ contact, endpoint, frame, sessions, timeoutMs: 50 })
    ).resolves.toBeUndefined();

    expect(endpoint.connect).toHaveBeenCalledWith("peer-bob", {
      timeoutMs: 15_000,
    });
    expect(endpoint.openStream).toHaveBeenCalledWith(
      "peer-bob",
      "/qop/chat/1",
      { timeoutMs: 50 }
    );
    expect(stream.write).toHaveBeenCalledOnce();
    expect(stream.closeWrite).toHaveBeenCalledOnce();
    expect(stream.reset).not.toHaveBeenCalled();
  });

  it("keeps sending on a verified connection during an RPC outage", async () => {
    const { endpoint, stream, sessions, lookupHandle } = makeEndpoint(
      ackReader(id)
    );
    await performSend({ contact, endpoint, frame, sessions, timeoutMs: 50 });
    const calls = lookupHandle.mock.calls.length;
    lookupHandle.mockReturnValue(
      Effect.fail(new RegistryReaderError({ operation: "rpc" }))
    );
    endpoint.connectedPeers.mockReturnValue([account.peerId]);
    stream.read.mockImplementation(ackReader(id));
    await performSend({ contact, endpoint, frame, sessions, timeoutMs: 50 });
    expect(lookupHandle).toHaveBeenCalledTimes(calls);
    expect(endpoint.connect).toHaveBeenCalledOnce();
    expect(stream.write).toHaveBeenCalledTimes(2);
  });

  it("rechecks a replacement connection before writing", async () => {
    const { endpoint, stream, sessions, lookupHandle } = makeEndpoint(
      ackReader(id)
    );
    await Effect.runPromise(sessions.verify(stream, contact.handle));
    endpoint.openStream.mockImplementation(() => {
      sessions.closed(stream);
      stream.connId = 2;
      sessions.opened(stream);
      lookupHandle.mockReturnValue(
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
    stream.peerId = "peer-impostor";
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
