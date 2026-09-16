import {
  CHAT_PROTOCOL,
  createPeerSessions,
  PeerVerificationError,
  RegistryReaderError,
} from "@qop/protocol";
import type { RegistryAccount } from "@qop/protocol";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { openAuthorizedChatStream } from "../src/chat.ts";

const PEER_BOB = "12D3KooWC7cDcNR4J3NC9y1gTkqafZKmnjCUvrRMxU2LMugGJGgy";
const bobDeviceKey = `0x${"22".repeat(32)}`;

const account: RegistryAccount = {
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

const makeSessions = () =>
  createPeerSessions({
    getContactByQid: () => Promise.resolve(null),
    lookupDeviceKey: () => Effect.succeed(account),
    lookupHandle: () => Effect.succeed(account),
    upsertContact: () => Promise.resolve(),
  });

const makeStream = () => ({
  closeWrite: vi.fn(),
  connId: 3,
  peerId: PEER_BOB,
  read: vi.fn(async (): Promise<undefined> => {
    await Promise.resolve();
  }),
  reset: vi.fn(),
  write: vi.fn(),
});

describe("openAuthorizedChatStream", () => {
  it("waits for Identify before opening /qop/chat/1", async () => {
    const sessions = makeSessions();
    const stream = makeStream();
    const order: string[] = [];
    const transport = {
      connect: vi.fn(() => {
        order.push("connect");
        return Promise.resolve({});
      }),
      connectedPeers: vi.fn((): string[] => []),
      openStream: vi.fn(() => {
        order.push("open");
        return Promise.resolve(stream);
      }),
      waitPeerReady: vi.fn(() => {
        order.push("ready");
        return Promise.resolve({});
      }),
    };

    await Effect.runPromise(
      openAuthorizedChatStream(transport, sessions, PEER_BOB, "bob")
    );
    expect(order).toEqual(["connect", "ready", "open"]);
    expect(transport.openStream).toHaveBeenCalledWith(PEER_BOB, CHAT_PROTOCOL, {
      timeoutMs: 15_000,
    });
    expect(sessions.isVerified(stream, "1")).toBe(true);
  });

  it("authorizes a live stream when connectionEstablished never fired", async () => {
    const sessions = makeSessions();
    const stream = makeStream();
    const closed = await Effect.runPromise(
      sessions.verify(stream, "bob").pipe(Effect.result)
    );
    expect(closed._tag).toBe("Failure");
    if (closed._tag === "Failure") {
      expect(closed.failure).toBeInstanceOf(PeerVerificationError);
      expect(closed.failure.operation).toBe("closed");
    }

    const transport = {
      connect: vi.fn(),
      connectedPeers: vi.fn((): string[] => [PEER_BOB]),
      openStream: vi.fn().mockResolvedValue(stream),
      waitPeerReady: vi.fn(async () => {
        await Promise.resolve();
        return {};
      }),
    };
    await Effect.runPromise(
      openAuthorizedChatStream(transport, sessions, PEER_BOB, "bob")
    );
    expect(transport.connect).not.toHaveBeenCalled();
    expect(sessions.isVerified(stream, "1")).toBe(true);
  });

  it("does not open a stream when Identify never completes", async () => {
    const sessions = makeSessions();
    const transport = {
      connect: vi.fn(async () => {
        await Promise.resolve();
        return {};
      }),
      connectedPeers: vi.fn((): string[] => []),
      openStream: vi.fn(),
      waitPeerReady: vi
        .fn()
        .mockRejectedValue(new Error("Timed out after 15000 ms")),
    };

    await expect(
      Effect.runPromise(
        openAuthorizedChatStream(transport, sessions, PEER_BOB, "bob")
      )
    ).rejects.toThrow("Timed out");
    expect(transport.openStream).not.toHaveBeenCalled();
  });

  it("resets the stream when authorization fails", async () => {
    const sessions = createPeerSessions({
      getContactByQid: () => Promise.resolve(null),
      lookupDeviceKey: () =>
        Effect.fail(new RegistryReaderError({ operation: "rpc" })),
      lookupHandle: () => Effect.succeed(account),
      upsertContact: () => Promise.resolve(),
    });
    const stream = makeStream();
    const transport = {
      connect: vi.fn(),
      connectedPeers: vi.fn((): string[] => [PEER_BOB]),
      openStream: vi.fn().mockResolvedValue(stream),
      waitPeerReady: vi.fn(async () => {
        await Promise.resolve();
        return {};
      }),
    };

    await expect(
      Effect.runPromise(
        openAuthorizedChatStream(transport, sessions, PEER_BOB, "bob")
      )
    ).rejects.toMatchObject({ operation: "rpc" });
    expect(stream.reset).toHaveBeenCalledOnce();
    expect(stream.write).not.toHaveBeenCalled();
  });

  it("resets once when verify succeeds but authorization is already gone", async () => {
    const sessions = makeSessions();
    const stream = makeStream();
    vi.spyOn(sessions, "isVerified").mockReturnValue(false);
    const transport = {
      connect: vi.fn(),
      connectedPeers: vi.fn((): string[] => [PEER_BOB]),
      openStream: vi.fn().mockResolvedValue(stream),
      waitPeerReady: vi.fn(async () => {
        await Promise.resolve();
        return {};
      }),
    };

    await expect(
      Effect.runPromise(
        openAuthorizedChatStream(transport, sessions, PEER_BOB, "bob")
      )
    ).rejects.toThrow("no longer authorized");
    expect(stream.reset).toHaveBeenCalledOnce();
    expect(stream.write).not.toHaveBeenCalled();
  });
});
