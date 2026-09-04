import { describe, expect, it, vi } from "vitest";

import { encodeAck } from "@/lib/chat-wire";
import { performSend } from "@/lib/p2p-send";

const id = "c56a4180-65aa-42ec-a945-5fd21dec0538";
const frame = {
  fromHandle: "alice",
  id,
  sentAt: 1_700_000_000_000,
  text: "hello",
  v: 1 as const,
};
const contact = { peerId: "peer-bob" };

const makeEndpoint = (read: () => Promise<Uint8Array | undefined>) => {
  const stream = {
    closeWrite: vi.fn(),
    read: vi.fn(read),
    reset: vi.fn(),
    write: vi.fn(),
  };
  const endpoint = {
    connect: vi.fn().mockImplementation(() => Promise.resolve()),
    openStream: vi.fn().mockResolvedValue(stream),
  };
  return { endpoint, stream };
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
    const { endpoint, stream } = makeEndpoint(ackReader(id));

    await expect(
      performSend({ contact, endpoint, frame, timeoutMs: 50 })
    ).resolves.toBeUndefined();

    expect(endpoint.connect).toHaveBeenCalledWith("peer-bob", {
      timeoutMs: 15_000,
    });
    expect(endpoint.openStream).toHaveBeenCalledWith("peer-bob", "/qop/chat/1");
    expect(stream.write).toHaveBeenCalledOnce();
    expect(stream.closeWrite).toHaveBeenCalledOnce();
    expect(stream.reset).not.toHaveBeenCalled();
  });

  it("rejects a mismatched ack", async () => {
    const { endpoint, stream } = makeEndpoint(
      ackReader("9b2c40a8-705b-4f3b-a3cc-3d723711d851")
    );

    await expect(
      performSend({ contact, endpoint, frame, timeoutMs: 50 })
    ).rejects.toThrow("does not match");
    expect(stream.reset).toHaveBeenCalledOnce();
  });

  it("times out when the peer sends no ack", async () => {
    const unread = Promise.withResolvers<Uint8Array | undefined>();
    const { endpoint, stream } = makeEndpoint(() => unread.promise);

    await expect(
      performSend({ contact, endpoint, frame, timeoutMs: 5 })
    ).rejects.toThrow("Timed out");
    expect(stream.reset).toHaveBeenCalledOnce();
  });
});
