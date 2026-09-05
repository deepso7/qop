import { Effect, Result } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { Contact } from "@/lib/db";
import { createPeerSessions } from "@/lib/p2p-sessions";
import { RegistryReaderError } from "@/lib/registry-core";
import type { RegistryAccount } from "@/lib/registry-core";

const PEER_ALICE = "12D3KooWC7cDcNR4J3NC9y1gTkqafZKmnjCUvrRMxU2LMugGJGgy";
const PEER_ROTATED = "12D3KooWDGEF3VLEM7R3XWGJsqPCcSSjwRmuNw6JTQMVMNSSzwAz";

const account: RegistryAccount = {
  deviceKey: `0x${"22".repeat(32)}`,
  handle: "alice",
  owner: "0x0000000000000000000000000000000000000001",
  ownerVersion: 0,
  peerId: PEER_ALICE,
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
  peerId: PEER_ROTATED,
};

const fixture = () => {
  const lookupDeviceKey = vi.fn(
    (
      _deviceKey: string
    ): Effect.Effect<RegistryAccount | null, RegistryReaderError> =>
      Effect.succeed(account)
  );
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
    lookupDeviceKey,
    lookupHandle,
    upsertContact,
  });
  sessions.opened(connection);
  return {
    getContactByQid,
    lookupDeviceKey,
    lookupHandle,
    sessions,
    upsertContact,
  };
};

describe("connection authorization", () => {
  it("reuses verification for messages in both directions even when RPC goes offline", async () => {
    const { lookupDeviceKey, lookupHandle, sessions, upsertContact } =
      fixture();
    expect(
      await Effect.runPromise(sessions.verify(connection, "alice"))
    ).toEqual(contact);
    lookupDeviceKey.mockReturnValue(
      Effect.fail(new RegistryReaderError({ operation: "rpc" }))
    );
    expect(
      await Effect.runPromise(sessions.verify(connection, "alice"))
    ).toEqual(contact);
    expect(await Effect.runPromise(sessions.recipientPeerId(contact))).toBe(
      account.peerId
    );
    expect(lookupDeviceKey).toHaveBeenCalledOnce();
    expect(lookupHandle).not.toHaveBeenCalled();
    expect(upsertContact).toHaveBeenCalledOnce();
  });

  it("observes rotation at reconnection and routes outgoing messages to the new device", async () => {
    const { lookupDeviceKey, lookupHandle, sessions } = fixture();
    await Effect.runPromise(sessions.verify(connection, "alice"));
    lookupHandle.mockReturnValue(Effect.succeed(rotated));
    expect(await Effect.runPromise(sessions.recipientPeerId(contact))).toBe(
      account.peerId
    );
    sessions.closed(connection);
    const oldReconnected = { ...connection, connId: 2 };
    sessions.opened(oldReconnected);
    lookupDeviceKey.mockReturnValue(Effect.succeed(rotated));
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
    const { lookupDeviceKey, sessions } = fixture();
    await Effect.runPromise(sessions.verify(connection, "alice"));
    const other = { ...connection, connId: 2 };
    sessions.opened(other);
    await Effect.runPromise(sessions.verify(other, "alice"));
    expect(lookupDeviceKey).toHaveBeenCalledTimes(2);
    sessions.closed(connection);
    expect(sessions.isVerified(other, "1")).toBe(true);
    expect(sessions.isVerified(connection, "1")).toBe(false);
  });

  it("shares concurrent verification on one connection", async () => {
    const { lookupDeviceKey, sessions } = fixture();
    await Effect.runPromise(
      Effect.all(
        [
          sessions.verify(connection, "alice"),
          sessions.verify(connection, "alice"),
        ],
        { concurrency: "unbounded" }
      )
    );
    expect(lookupDeviceKey).toHaveBeenCalledOnce();
  });

  it("rejects a different claimed handle on an already verified connection", async () => {
    const { lookupDeviceKey, sessions } = fixture();
    await Effect.runPromise(sessions.verify(connection, "alice"));
    const result = await Effect.runPromise(
      sessions.verify(connection, "bob").pipe(Effect.result)
    );
    expect(Result.isFailure(result) && result.failure.operation).toBe(
      "identity"
    );
    expect(lookupDeviceKey).toHaveBeenCalledOnce();
  });

  it("requires RPC verification again after disconnect and retries transient failures", async () => {
    const { lookupDeviceKey, sessions } = fixture();
    await Effect.runPromise(sessions.verify(connection, "alice"));
    sessions.closed(connection);
    sessions.opened(connection);
    lookupDeviceKey.mockReturnValueOnce(
      Effect.fail(new RegistryReaderError({ operation: "rpc" }))
    );
    const result = await Effect.runPromise(
      sessions.verify(connection, "alice").pipe(Effect.result)
    );
    expect(Result.isFailure(result) && result.failure.operation).toBe("rpc");
    expect(sessions.isVerified(connection, "1")).toBe(false);
    await Effect.runPromise(sessions.verify(connection, "alice"));
    expect(lookupDeviceKey).toHaveBeenCalledTimes(3);
  });

  it("does not restore authorization when an old lookup finishes after reconnect", async () => {
    const { lookupDeviceKey, sessions, upsertContact } = fixture();
    const pending = Promise.withResolvers<RegistryAccount>();
    lookupDeviceKey.mockReturnValueOnce(Effect.promise(() => pending.promise));
    const result = Effect.runPromise(
      sessions.verify(connection, "alice").pipe(Effect.result)
    );
    await vi.waitFor(() => expect(lookupDeviceKey).toHaveBeenCalledOnce());
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
    const { lookupDeviceKey, lookupHandle, sessions, upsertContact } =
      fixture();
    lookupDeviceKey.mockReturnValueOnce(Effect.succeed(null));
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
    expect(lookupHandle).toHaveBeenCalledOnce();
  });

  it("rejects a claimed handle that does not match the transport peer's registry account", async () => {
    const { lookupDeviceKey, sessions, upsertContact } = fixture();
    const result = await Effect.runPromise(
      sessions.verify(connection, "bob").pipe(Effect.result)
    );
    expect(Result.isFailure(result) && result.failure.operation).toBe(
      "identity"
    );
    expect(lookupDeviceKey).toHaveBeenCalledWith(account.deviceKey);
    expect(upsertContact).not.toHaveBeenCalled();
  });

  it("maps contact storage failures to storage and does not cache authorization", async () => {
    const { getContactByQid, lookupDeviceKey, sessions, upsertContact } =
      fixture();
    getContactByQid.mockRejectedValueOnce(new Error("db read failed"));
    const readFailed = await Effect.runPromise(
      sessions.verify(connection, "alice").pipe(Effect.result)
    );
    expect(Result.isFailure(readFailed) && readFailed.failure.operation).toBe(
      "storage"
    );
    expect(sessions.isVerified(connection, "1")).toBe(false);
    expect(upsertContact).not.toHaveBeenCalled();

    getContactByQid.mockResolvedValue(contact);
    upsertContact.mockRejectedValueOnce(new Error("db write failed"));
    const writeFailed = await Effect.runPromise(
      sessions.verify(connection, "alice").pipe(Effect.result)
    );
    expect(Result.isFailure(writeFailed) && writeFailed.failure.operation).toBe(
      "storage"
    );
    expect(sessions.isVerified(connection, "1")).toBe(false);
    expect(lookupDeviceKey).toHaveBeenCalledTimes(2);

    upsertContact.mockResolvedValue(undefined);
    expect(
      await Effect.runPromise(sessions.verify(connection, "alice"))
    ).toEqual(contact);
    expect(sessions.isVerified(connection, "1")).toBe(true);
  });
});
