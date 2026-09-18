import { it as itEffect } from "@effect/vitest";
import { PeerDisconnectedError } from "@minip2p/node";
import {
  CHAT_PROTOCOL,
  createPeerSessions,
  encodeAck,
  PeerVerificationError,
  RegistryReaderError,
} from "@qop/protocol";
import type { ChatFrame, InboxRecordV1, RegistryAccount } from "@qop/protocol";
import { Deferred, Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it, vi } from "vitest";

import {
  ackInboundChatFrame,
  CHAT_CONNECT_TIMEOUT_MS,
  deliverChatFrame,
  OUTBOUND_ACK_TIMEOUT_MS,
  openAuthorizedChatStream,
} from "../src/chat.ts";
import { CliOutboxStoreError } from "../src/outbox-store.ts";

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

const makeStream = () => {
  const unread: (Uint8Array | undefined)[] = [];
  return {
    closeWrite: vi.fn(),
    connId: 3,
    peerId: PEER_BOB,
    read: vi.fn(async () => {
      await Promise.resolve();
      return unread.shift();
    }),
    reset: vi.fn(),
    write: vi.fn(),
  };
};

const bobRecipient = { handle: "bob", qid: "1" } as const;

describe("openAuthorizedChatStream", () => {
  it("reopens and authorizes chat after a connection is replaced during setup", async () => {
    const sessions = makeSessions();
    const stream = makeStream();
    const transport = {
      connect: vi.fn().mockResolvedValue({}),
      connectedPeers: vi.fn((): string[] => [PEER_BOB]),
      openStream: vi
        .fn()
        .mockRejectedValueOnce(
          new PeerDisconnectedError(PEER_BOB, "openStream")
        )
        .mockResolvedValue(stream),
      waitPeerReady: vi.fn().mockResolvedValue({}),
    };

    const opened = await Effect.runPromise(
      openAuthorizedChatStream(transport, sessions, PEER_BOB, bobRecipient)
    );
    expect(opened).toBe(stream);
    expect(transport.waitPeerReady).toHaveBeenCalledTimes(2);
    expect(sessions.isVerified(stream, "1")).toBe(true);
    expect(stream.write).not.toHaveBeenCalled();
  });

  it("stops after one retry when stream setup keeps disconnecting", async () => {
    const transport = {
      connect: vi.fn().mockResolvedValue({}),
      connectedPeers: vi.fn((): string[] => [PEER_BOB]),
      openStream: vi
        .fn()
        .mockRejectedValue(new PeerDisconnectedError(PEER_BOB, "openStream")),
      waitPeerReady: vi.fn().mockResolvedValue({}),
    };
    await expect(
      Effect.runPromise(
        openAuthorizedChatStream(
          transport,
          makeSessions(),
          PEER_BOB,
          bobRecipient
        )
      )
    ).rejects.toBeInstanceOf(PeerDisconnectedError);
    expect(transport.openStream).toHaveBeenCalledTimes(2);
  });

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
      openAuthorizedChatStream(transport, sessions, PEER_BOB, bobRecipient)
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
      openAuthorizedChatStream(transport, sessions, PEER_BOB, bobRecipient)
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
        openAuthorizedChatStream(transport, sessions, PEER_BOB, bobRecipient)
      )
    ).rejects.toMatchObject({
      _tag: "CliOutboxDeliverError",
      operation: "transport",
    });
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
        openAuthorizedChatStream(transport, sessions, PEER_BOB, bobRecipient)
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
        openAuthorizedChatStream(transport, sessions, PEER_BOB, bobRecipient)
      )
    ).rejects.toMatchObject({
      _tag: "CliOutboxDeliverError",
      operation: "unauthorized",
    });
    expect(stream.reset).toHaveBeenCalledOnce();
    expect(stream.write).not.toHaveBeenCalled();
  });

  it("rejects when verify authorizes a different QID than the selected recipient", async () => {
    const reassigned: RegistryAccount = { ...account, qid: 2n };
    const sessions = createPeerSessions({
      getContactByQid: () => Promise.resolve(null),
      lookupDeviceKey: () => Effect.succeed(reassigned),
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
        openAuthorizedChatStream(transport, sessions, PEER_BOB, bobRecipient)
      )
    ).rejects.toMatchObject({ operation: "identity" });
    expect(stream.reset).toHaveBeenCalledOnce();
    expect(stream.write).not.toHaveBeenCalled();
    expect(sessions.isVerified(stream, "1")).toBe(false);
  });

  itEffect.effect("resets the stream when authorization is interrupted", () =>
    Effect.gen(function* () {
      const sessions = makeSessions();
      const stream = makeStream();
      const started = yield* Deferred.make<boolean>();
      const hang = yield* Deferred.make<never>();
      vi.spyOn(sessions, "verify").mockImplementation(() => {
        Effect.runSync(Deferred.succeed(started, true));
        return Deferred.await(hang);
      });
      const transport = {
        connect: vi.fn(),
        connectedPeers: vi.fn((): string[] => [PEER_BOB]),
        openStream: vi.fn().mockResolvedValue(stream),
        waitPeerReady: vi.fn(async () => {
          await Promise.resolve();
          return {};
        }),
      };
      const fiber = yield* Effect.forkChild(
        openAuthorizedChatStream(transport, sessions, PEER_BOB, bobRecipient)
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(stream.reset).toHaveBeenCalledOnce();
      expect(stream.write).not.toHaveBeenCalled();
    })
  );
});

const chatFrame: ChatFrame = {
  fromHandle: "alice",
  id: "c56a4180-65aa-42ec-a945-5fd21dec0538",
  sentAt: 1_700_000_000_000,
  text: "hello",
  v: 1,
};

describe("deliverChatFrame", () => {
  itEffect.effect("times out a hung outbound ack and resets the stream", () =>
    Effect.gen(function* () {
      const sessions = makeSessions();
      const stream = makeStream();
      const hang = yield* Deferred.make<Uint8Array>();
      stream.read.mockImplementation(() =>
        Effect.runPromise(Deferred.await(hang))
      );
      const transport = {
        connect: vi.fn(),
        connectedPeers: vi.fn((): string[] => [PEER_BOB]),
        openStream: vi.fn().mockResolvedValue(stream),
        waitPeerReady: vi.fn(async () => {
          await Promise.resolve();
          return {};
        }),
      };
      const fiber = yield* Effect.forkChild(
        deliverChatFrame(transport, sessions, bobRecipient, chatFrame)
      );
      yield* TestClock.adjust(Duration.millis(OUTBOUND_ACK_TIMEOUT_MS + 1));
      const result = yield* Fiber.join(fiber).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "CliOutboxDeliverError",
          operation: "timeout",
        });
      }
      expect(stream.write).toHaveBeenCalledOnce();
      expect(stream.closeWrite).toHaveBeenCalledOnce();
      expect(stream.reset).toHaveBeenCalledOnce();
    })
  );

  it("does not write when authorization is invalidated after verify", async () => {
    const sessions = makeSessions();
    const stream = makeStream();
    const originalIsVerified = sessions.isVerified.bind(sessions);
    vi.spyOn(sessions, "isVerified").mockImplementation((connection, qid) => {
      const authorized = originalIsVerified(connection, qid);
      sessions.invalidateAuthorization();
      return authorized;
    });
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
        deliverChatFrame(transport, sessions, bobRecipient, chatFrame)
      )
    ).rejects.toMatchObject({
      _tag: "CliOutboxDeliverError",
      operation: "unauthorized",
    });
    expect(stream.write).not.toHaveBeenCalled();
    expect(stream.reset).toHaveBeenCalledOnce();
  });

  it("does not reset after a matching ack", async () => {
    const sessions = makeSessions();
    const stream = makeStream();
    const unread = [encodeAck({ ack: chatFrame.id, v: 1 })];
    stream.read.mockImplementation(async () => {
      await Promise.resolve();
      return unread.shift();
    });
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
      deliverChatFrame(transport, sessions, bobRecipient, chatFrame)
    );
    expect(stream.write).toHaveBeenCalledOnce();
    expect(stream.closeWrite).toHaveBeenCalledOnce();
    expect(stream.reset).not.toHaveBeenCalled();
  });

  it("resets the stream when the ack id does not match", async () => {
    const sessions = makeSessions();
    const stream = makeStream();
    const unread = [
      encodeAck({ ack: "d56a4180-65aa-42ec-a945-5fd21dec0538", v: 1 }),
    ];
    stream.read.mockImplementation(async () => {
      await Promise.resolve();
      return unread.shift();
    });
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
        deliverChatFrame(transport, sessions, bobRecipient, chatFrame)
      )
    ).rejects.toMatchObject({
      _tag: "CliOutboxDeliverError",
      operation: "transport",
    });
    expect(stream.write).toHaveBeenCalledOnce();
    expect(stream.reset).toHaveBeenCalledOnce();
  });

  itEffect.effect("resets the stream when delivery is interrupted", () =>
    Effect.gen(function* () {
      const sessions = makeSessions();
      const stream = makeStream();
      const written = yield* Deferred.make<boolean>();
      const hang = yield* Deferred.make<Uint8Array>();
      stream.write.mockImplementation(() => {
        Effect.runSync(Deferred.succeed(written, true));
      });
      stream.read.mockImplementation(() =>
        Effect.runPromise(Deferred.await(hang))
      );
      const transport = {
        connect: vi.fn(),
        connectedPeers: vi.fn((): string[] => [PEER_BOB]),
        openStream: vi.fn().mockResolvedValue(stream),
        waitPeerReady: vi.fn(async () => {
          await Promise.resolve();
          return {};
        }),
      };
      const fiber = yield* Effect.forkChild(
        deliverChatFrame(transport, sessions, bobRecipient, chatFrame)
      );
      yield* Deferred.await(written);
      yield* Fiber.interrupt(fiber);
      expect(stream.write).toHaveBeenCalledOnce();
      expect(stream.reset).toHaveBeenCalledOnce();
    })
  );

  it("falls through to the next roster device when the first dial fails", async () => {
    const peerCli = "12D3KooWDGEF3VLEM7R3XWGJsqPCcSSjwRmuNw6JTQMVMNSSzwAz";
    const cliDeviceKey = `0x${"33".repeat(32)}`;
    const multiAccount: RegistryAccount = {
      ...account,
      devices: [
        { deviceKey: bobDeviceKey, peerId: PEER_BOB },
        { deviceKey: cliDeviceKey, peerId: peerCli },
      ],
    };
    const sessions = createPeerSessions({
      getContactByQid: () => Promise.resolve(null),
      lookupDeviceKey: () => Effect.succeed(multiAccount),
      lookupHandle: () => Effect.succeed(multiAccount),
      upsertContact: () => Promise.resolve(),
    });
    const stream = makeStream();
    stream.peerId = peerCli;
    const unread = [encodeAck({ ack: chatFrame.id, v: 1 })];
    stream.read.mockImplementation(async () => {
      await Promise.resolve();
      return unread.shift();
    });
    const transport = {
      connect: vi.fn((peerId: string) => {
        if (peerId === PEER_BOB) {
          return Promise.reject(new Error("phone offline"));
        }
        return Promise.resolve({});
      }),
      connectedPeers: vi.fn((): string[] => []),
      openStream: vi.fn().mockResolvedValue(stream),
      waitPeerReady: vi.fn().mockResolvedValue({}),
    };
    await Effect.runPromise(
      deliverChatFrame(transport, sessions, bobRecipient, chatFrame)
    );
    expect(transport.connect).toHaveBeenCalledWith(PEER_BOB, {
      timeoutMs: CHAT_CONNECT_TIMEOUT_MS,
    });
    expect(transport.connect).toHaveBeenCalledWith(peerCli, {
      timeoutMs: CHAT_CONNECT_TIMEOUT_MS,
    });
    expect(stream.write).toHaveBeenCalledOnce();
    expect(stream.reset).not.toHaveBeenCalled();
  });

  it("falls through when a live authorized phone cannot be dialed", async () => {
    const peerCli = "12D3KooWDGEF3VLEM7R3XWGJsqPCcSSjwRmuNw6JTQMVMNSSzwAz";
    const cliDeviceKey = `0x${"33".repeat(32)}`;
    const multiAccount: RegistryAccount = {
      ...account,
      devices: [
        { deviceKey: bobDeviceKey, peerId: PEER_BOB },
        { deviceKey: cliDeviceKey, peerId: peerCli },
      ],
    };
    const sessions = createPeerSessions({
      getContactByQid: () => Promise.resolve(null),
      lookupDeviceKey: () => Effect.succeed(multiAccount),
      lookupHandle: () => Effect.succeed(multiAccount),
      upsertContact: () => Promise.resolve(),
    });
    const phone = makeStream();
    sessions.opened(phone);
    await Effect.runPromise(sessions.verify(phone, bobRecipient.handle));
    const stream = makeStream();
    stream.connId = 4;
    stream.peerId = peerCli;
    const unread = [encodeAck({ ack: chatFrame.id, v: 1 })];
    stream.read.mockImplementation(async () => {
      await Promise.resolve();
      return unread.shift();
    });
    const transport = {
      connect: vi.fn((peerId: string) => {
        if (peerId === PEER_BOB) {
          return Promise.reject(new Error("phone offline"));
        }
        return Promise.resolve({});
      }),
      connectedPeers: vi.fn((): string[] => []),
      openStream: vi.fn().mockResolvedValue(stream),
      waitPeerReady: vi.fn().mockResolvedValue({}),
    };
    await Effect.runPromise(
      deliverChatFrame(transport, sessions, bobRecipient, chatFrame)
    );
    expect(transport.connect.mock.calls.map(([peerId]) => peerId)).toEqual([
      PEER_BOB,
      peerCli,
    ]);
    expect(stream.write).toHaveBeenCalledOnce();
    expect(stream.reset).not.toHaveBeenCalled();
  });
});

const inboundRecord: InboxRecordV1 = {
  frame: chatFrame,
  fromQid: "1",
  receivedAt: 1_700_000_000_001,
  v: 1,
};

describe("ackInboundChatFrame", () => {
  itEffect.effect("does not ack when putInbox fails", () =>
    Effect.gen(function* () {
      const stream = makeStream();
      const result = yield* ackInboundChatFrame(stream, inboundRecord, () =>
        Effect.fail(new CliOutboxStoreError({ operation: "write" }))
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(stream.write).not.toHaveBeenCalled();
      expect(stream.closeWrite).not.toHaveBeenCalled();
      expect(stream.reset).not.toHaveBeenCalled();
    })
  );

  itEffect.effect("acks after persisting a new inbox record", () =>
    Effect.gen(function* () {
      const stream = makeStream();
      const saved = yield* ackInboundChatFrame(
        stream,
        inboundRecord,
        (record) => Effect.succeed({ inserted: true, record })
      );
      expect(saved.inserted).toBe(true);
      expect(stream.write).toHaveBeenCalledOnce();
      expect(stream.closeWrite).toHaveBeenCalledOnce();
    })
  );

  itEffect.effect("acks a duplicate without treating it as inserted", () =>
    Effect.gen(function* () {
      const stream = makeStream();
      const saved = yield* ackInboundChatFrame(
        stream,
        inboundRecord,
        (record) => Effect.succeed({ inserted: false, record })
      );
      expect(saved.inserted).toBe(false);
      expect(stream.write).toHaveBeenCalledOnce();
      expect(stream.closeWrite).toHaveBeenCalledOnce();
    })
  );
});
