import { Effect, Result } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { Contact } from "@/lib/db";
import { createPeerSessions } from "@/lib/p2p-sessions";
import { RegistryReaderError } from "@/lib/registry-core";
import type { RegistryAccount } from "@/lib/registry-core";

const account: RegistryAccount = {
  deviceKey: `0x${"22".repeat(32)}`,
  handle: "alice",
  owner: "0x0000000000000000000000000000000000000001",
  ownerVersion: 0,
  peerId: "peer-alice",
  qid: 1n,
  registeredAt: 1_700_000_000n,
};
const contact: Contact = {
  createdAt: 1_700_000_000_000,
  deviceKey: account.deviceKey,
  handle: account.handle,
  keyChanged: false,
  lastReadAt: 42,
  owner: account.owner,
  peerId: account.peerId,
  qid: "1",
};
const connection = { connId: 1, peerId: account.peerId };
const rotated = {
  ...account,
  deviceKey: `0x${"33".repeat(32)}` as const,
  peerId: "peer-new",
};

const fixture = () => {
  const lookupHandle = vi.fn(
    (
      _handle: string
    ): Effect.Effect<RegistryAccount | null, RegistryReaderError> =>
      Effect.succeed(account)
  );
  const upsertContact = vi.fn(() => Promise.resolve());
  const getContactByQid = vi.fn(() => Promise.resolve(contact));
  const sessions = createPeerSessions({
    getContactByQid,
    lookupHandle,
    upsertContact,
  });
  sessions.opened(connection);
  return { getContactByQid, lookupHandle, sessions, upsertContact };
};

describe("connection authorization", () => {
  it("reuses verification for messages in both directions even when RPC goes offline", async () => {
    const { lookupHandle, sessions, upsertContact } = fixture();
    expect(
      await Effect.runPromise(sessions.verify(connection, "alice"))
    ).toEqual(contact);
    lookupHandle.mockReturnValue(
      Effect.fail(new RegistryReaderError({ operation: "rpc" }))
    );
    expect(
      await Effect.runPromise(sessions.verify(connection, "alice"))
    ).toEqual(contact);
    expect(await Effect.runPromise(sessions.recipientPeerId(contact))).toBe(
      account.peerId
    );
    expect(lookupHandle).toHaveBeenCalledOnce();
    expect(upsertContact).toHaveBeenCalledOnce();
  });

  it("observes rotation at reconnection and routes outgoing messages to the new device", async () => {
    const { lookupHandle, sessions } = fixture();
    await Effect.runPromise(sessions.verify(connection, "alice"));
    lookupHandle.mockReturnValue(Effect.succeed(rotated));
    expect(await Effect.runPromise(sessions.recipientPeerId(contact))).toBe(
      account.peerId
    );
    sessions.closed(connection);
    const oldReconnected = { ...connection, connId: 2 };
    sessions.opened(oldReconnected);
    const denied = await Effect.runPromise(
      sessions.verify(oldReconnected, "alice").pipe(Effect.result)
    );
    expect(Result.isFailure(denied) && denied.failure.operation).toBe(
      "identity"
    );
    expect(await Effect.runPromise(sessions.recipientPeerId(contact))).toBe(
      rotated.peerId
    );
    const newConnection = { connId: 3, peerId: rotated.peerId };
    sessions.opened(newConnection);
    expect(
      await Effect.runPromise(sessions.verify(newConnection, "alice"))
    ).toMatchObject({
      keyChanged: true,
      lastReadAt: 42,
      peerId: rotated.peerId,
    });
  });

  it("does not share authorization across parallel connections to the same peer", async () => {
    const { lookupHandle, sessions } = fixture();
    await Effect.runPromise(sessions.verify(connection, "alice"));
    const other = { ...connection, connId: 2 };
    sessions.opened(other);
    await Effect.runPromise(sessions.verify(other, "alice"));
    expect(lookupHandle).toHaveBeenCalledTimes(2);
    sessions.closed(connection);
    expect(sessions.isVerified(other, "1")).toBe(true);
    expect(sessions.isVerified(connection, "1")).toBe(false);
  });

  it("shares concurrent verification on one connection", async () => {
    const { lookupHandle, sessions } = fixture();
    await Effect.runPromise(
      Effect.all(
        [
          sessions.verify(connection, "alice"),
          sessions.verify(connection, "alice"),
        ],
        { concurrency: "unbounded" }
      )
    );
    expect(lookupHandle).toHaveBeenCalledOnce();
  });

  it("rejects a different claimed handle on an already verified connection", async () => {
    const { lookupHandle, sessions } = fixture();
    await Effect.runPromise(sessions.verify(connection, "alice"));
    const result = await Effect.runPromise(
      sessions.verify(connection, "bob").pipe(Effect.result)
    );
    expect(Result.isFailure(result) && result.failure.operation).toBe(
      "identity"
    );
    expect(lookupHandle).toHaveBeenCalledOnce();
  });

  it("requires RPC verification again after disconnect and retries transient failures", async () => {
    const { lookupHandle, sessions } = fixture();
    await Effect.runPromise(sessions.verify(connection, "alice"));
    sessions.closed(connection);
    sessions.opened(connection);
    lookupHandle.mockReturnValueOnce(
      Effect.fail(new RegistryReaderError({ operation: "rpc" }))
    );
    const result = await Effect.runPromise(
      sessions.verify(connection, "alice").pipe(Effect.result)
    );
    expect(Result.isFailure(result) && result.failure.operation).toBe("rpc");
    expect(sessions.isVerified(connection, "1")).toBe(false);
    await Effect.runPromise(sessions.verify(connection, "alice"));
    expect(lookupHandle).toHaveBeenCalledTimes(3);
  });

  it("does not restore authorization when an old lookup finishes after reconnect", async () => {
    const { lookupHandle, sessions, upsertContact } = fixture();
    const pending = Promise.withResolvers<RegistryAccount>();
    lookupHandle.mockReturnValueOnce(Effect.promise(() => pending.promise));
    const result = Effect.runPromise(
      sessions.verify(connection, "alice").pipe(Effect.result)
    );
    await vi.waitFor(() => expect(lookupHandle).toHaveBeenCalledOnce());
    sessions.closed(connection);
    sessions.opened(connection);
    pending.resolve(account);
    const denied = await result;
    expect(Result.isFailure(denied) && denied.failure.operation).toBe("closed");
    expect(upsertContact).not.toHaveBeenCalled();
    expect(sessions.isVerified(connection, "1")).toBe(false);
  });

  it("clears authorization on endpoint shutdown or lost lifecycle events", async () => {
    const { sessions } = fixture();
    await Effect.runPromise(sessions.verify(connection, "alice"));
    sessions.clear();
    expect(sessions.isVerified(connection, "1")).toBe(false);
    const result = await Effect.runPromise(
      sessions.verify(connection, "alice").pipe(Effect.result)
    );
    expect(Result.isFailure(result) && result.failure.operation).toBe("closed");
  });

  it("rejects an absent account and an unexpected qid", async () => {
    const { lookupHandle, sessions, upsertContact } = fixture();
    lookupHandle.mockReturnValueOnce(Effect.succeed(null));
    const absent = await Effect.runPromise(
      sessions.verify(connection, "alice").pipe(Effect.result)
    );
    expect(Result.isFailure(absent) && absent.failure.operation).toBe(
      "identity"
    );
    expect(upsertContact).not.toHaveBeenCalled();
    const mismatched = await Effect.runPromise(
      sessions.recipientPeerId({ ...contact, qid: "2" }).pipe(Effect.result)
    );
    expect(Result.isFailure(mismatched) && mismatched.failure.operation).toBe(
      "identity"
    );
  });
});
