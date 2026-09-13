import { Effect, Result } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { Contact } from "@/lib/db";
import { createPeerSessions, MAX_AUTH_AGE_MS } from "@/lib/p2p-sessions";
import { RegistryReaderError } from "@/lib/registry-core";
import type { RegistryAccount } from "@/lib/registry-core";

const PEER_ALICE = "12D3KooWC7cDcNR4J3NC9y1gTkqafZKmnjCUvrRMxU2LMugGJGgy";
const PEER_CLI = "12D3KooWDGEF3VLEM7R3XWGJsqPCcSSjwRmuNw6JTQMVMNSSzwAz";

const phoneDeviceKey = `0x${"22".repeat(32)}` as const;
const cliDeviceKey = `0x${"33".repeat(32)}` as const;

const phoneAccount = (): RegistryAccount => ({
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
  qid: 1n,
  registeredAt: 1_700_000_000n,
});

const contact: Contact = {
  createdAt: 1_700_000_000_000,
  deviceKey: phoneDeviceKey,
  handle: "alice",
  keyChanged: false,
  lastReadAt: 42,
  owner: "0x0000000000000000000000000000000000000001",
  peerId: PEER_ALICE,
  qid: "1",
};

const phoneConnection = { connId: 1, peerId: PEER_ALICE };
const cliConnection = { connId: 2, peerId: PEER_CLI };

const fixture = (options?: { now?: () => number }) => {
  let clock = 0;
  const now = options?.now ?? (() => clock);
  const lookupDeviceKey = vi.fn(
    (
      deviceKey: string
    ): Effect.Effect<RegistryAccount | null, RegistryReaderError> => {
      if (deviceKey === phoneDeviceKey) {
        return Effect.succeed(phoneAccount());
      }
      if (deviceKey === cliDeviceKey) {
        // Primary peerId stays the phone's; CLI must still verify via devices[].
        return Effect.succeed(phoneAccount());
      }
      return Effect.succeed(null);
    }
  );
  const lookupHandle = vi.fn(
    (
      _handle: string
    ): Effect.Effect<RegistryAccount | null, RegistryReaderError> =>
      Effect.succeed(phoneAccount())
  );
  const upsertContact = vi.fn(() => Promise.resolve());
  const getContactByQid = vi.fn((_qid: string): Promise<Contact | null> =>
    Promise.resolve(contact)
  );
  const sessions = createPeerSessions({
    getContactByQid,
    lookupDeviceKey,
    lookupHandle,
    now,
    upsertContact,
  });
  sessions.opened(phoneConnection);
  sessions.opened(cliConnection);
  return {
    advance: (ms: number) => {
      clock += ms;
    },
    getContactByQid,
    lookupDeviceKey,
    lookupHandle,
    sessions,
    upsertContact,
  };
};

describe("multi-device connection authorization", () => {
  it("accepts phone and CLI devices as the same qid without keyChanged", async () => {
    const { lookupDeviceKey, sessions, upsertContact } = fixture();
    await expect(
      Effect.runPromise(sessions.verify(phoneConnection, "alice"))
    ).resolves.toMatchObject({
      keyChanged: false,
      peerId: PEER_ALICE,
      qid: "1",
    });
    await expect(
      Effect.runPromise(sessions.verify(cliConnection, "alice"))
    ).resolves.toMatchObject({
      keyChanged: false,
      peerId: PEER_CLI,
      qid: "1",
    });
    expect(lookupDeviceKey).toHaveBeenCalledTimes(2);
    expect(upsertContact).toHaveBeenCalledTimes(2);
    expect(sessions.isVerified(phoneConnection, "1")).toBe(true);
    expect(sessions.isVerified(cliConnection, "1")).toBe(true);
  });

  it("reuses verification within the max auth age even when RPC goes offline", async () => {
    const { advance, lookupDeviceKey, sessions } = fixture();
    await Effect.runPromise(sessions.verify(phoneConnection, "alice"));
    lookupDeviceKey.mockReturnValue(
      Effect.fail(new RegistryReaderError({ operation: "rpc" }))
    );
    advance(MAX_AUTH_AGE_MS - 1);
    await expect(
      Effect.runPromise(sessions.verify(phoneConnection, "alice"))
    ).resolves.toMatchObject({ peerId: PEER_ALICE });
    expect(lookupDeviceKey).toHaveBeenCalledOnce();
  });

  it("rechecks after max age and refuses when the device was removed", async () => {
    const { advance, lookupDeviceKey, sessions } = fixture();
    await Effect.runPromise(sessions.verify(cliConnection, "alice"));
    expect(sessions.isVerified(cliConnection, "1")).toBe(true);

    lookupDeviceKey.mockImplementation((deviceKey: string) => {
      if (deviceKey === phoneDeviceKey) {
        return Effect.succeed({
          ...phoneAccount(),
          devices: [{ deviceKey: phoneDeviceKey, peerId: PEER_ALICE }],
        });
      }
      return Effect.succeed(null);
    });
    advance(MAX_AUTH_AGE_MS);
    const revoked = await Effect.runPromise(
      sessions.verify(cliConnection, "alice").pipe(Effect.result)
    );
    expect(Result.isFailure(revoked) && revoked.failure.operation).toBe(
      "identity"
    );
    expect(sessions.isVerified(cliConnection, "1")).toBe(false);
    await expect(
      Effect.runPromise(sessions.verify(phoneConnection, "alice"))
    ).resolves.toMatchObject({ peerId: PEER_ALICE });
    expect(sessions.isVerified(phoneConnection, "1")).toBe(true);
  });

  it("does not extend expired auth when RPC fails during recheck", async () => {
    const { advance, lookupDeviceKey, sessions } = fixture();
    await Effect.runPromise(sessions.verify(phoneConnection, "alice"));
    advance(MAX_AUTH_AGE_MS);
    lookupDeviceKey.mockReturnValue(
      Effect.fail(new RegistryReaderError({ operation: "rpc" }))
    );
    const refused = await Effect.runPromise(
      sessions.verify(phoneConnection, "alice").pipe(Effect.result)
    );
    expect(Result.isFailure(refused) && refused.failure.operation).toBe("rpc");
    expect(sessions.isVerified(phoneConnection, "1")).toBe(false);
  });

  it("invalidates cached authorization on resume before sensitive ops", async () => {
    const { lookupDeviceKey, sessions } = fixture();
    await Effect.runPromise(sessions.verify(phoneConnection, "alice"));
    expect(lookupDeviceKey).toHaveBeenCalledOnce();
    sessions.invalidateAuthorization();
    expect(sessions.isVerified(phoneConnection, "1")).toBe(false);
    // Resume keeps freshness history; only a strictly newer live head may remint.
    lookupDeviceKey.mockReturnValue(
      Effect.succeed({
        ...phoneAccount(),
        blockNumber: 2n,
        freshness: "fresh",
      })
    );
    await Effect.runPromise(sessions.verify(phoneConnection, "alice"));
    expect(lookupDeviceKey).toHaveBeenCalledTimes(2);
    expect(sessions.isVerified(phoneConnection, "1")).toBe(true);
  });

  it("measures auth age by the injected now() clock", async () => {
    let clock = 0;
    const { lookupDeviceKey, sessions } = fixture({
      now: () => clock,
    });
    await Effect.runPromise(sessions.verify(phoneConnection, "alice"));
    lookupDeviceKey.mockReturnValue(
      Effect.fail(new RegistryReaderError({ operation: "rpc" }))
    );
    // Auth age follows the injected now() advance, not an implicit wall clock.
    clock += MAX_AUTH_AGE_MS - 1;
    await expect(
      Effect.runPromise(sessions.verify(phoneConnection, "alice"))
    ).resolves.toMatchObject({ qid: "1" });
    clock += 2;
    const refused = await Effect.runPromise(
      sessions.verify(phoneConnection, "alice").pipe(Effect.result)
    );
    expect(Result.isFailure(refused) && refused.failure.operation).toBe("rpc");
  });

  it("expires auth from registry confirm time, not after slow storage", async () => {
    const storageDelayMs = 9000;
    const { advance, sessions, upsertContact } = fixture();
    upsertContact.mockImplementation(() => {
      advance(storageDelayMs);
      return Promise.resolve();
    });
    await Effect.runPromise(sessions.verify(phoneConnection, "alice"));
    expect(sessions.isVerified(phoneConnection, "1")).toBe(true);
    // Still inside post-storage 60s, but past confirm + 60s.
    advance(MAX_AUTH_AGE_MS - storageDelayMs + 1);
    expect(sessions.isVerified(phoneConnection, "1")).toBe(false);
  });

  it("routes outgoing messages to a live authorized device peer", async () => {
    const { sessions } = fixture();
    await Effect.runPromise(sessions.verify(cliConnection, "alice"));
    await expect(
      Effect.runPromise(sessions.recipientPeerId(contact))
    ).resolves.toBe(PEER_CLI);
  });

  it("does not share authorization across parallel connections", async () => {
    const { lookupDeviceKey, sessions } = fixture();
    await Effect.runPromise(sessions.verify(phoneConnection, "alice"));
    const other = { ...phoneConnection, connId: 9 };
    sessions.opened(other);
    await Effect.runPromise(sessions.verify(other, "alice"));
    expect(lookupDeviceKey).toHaveBeenCalledTimes(2);
    sessions.closed(phoneConnection);
    expect(sessions.isVerified(other, "1")).toBe(true);
    expect(sessions.isVerified(phoneConnection, "1")).toBe(false);
  });

  it("shares concurrent verification on one connection", async () => {
    const { lookupDeviceKey, sessions } = fixture();
    await Effect.runPromise(
      Effect.all(
        [
          sessions.verify(phoneConnection, "alice"),
          sessions.verify(phoneConnection, "alice"),
        ],
        { concurrency: "unbounded" }
      )
    );
    expect(lookupDeviceKey).toHaveBeenCalledOnce();
  });

  it("rejects a different claimed handle on an already verified connection", async () => {
    const { lookupDeviceKey, sessions } = fixture();
    await Effect.runPromise(sessions.verify(phoneConnection, "alice"));
    const result = await Effect.runPromise(
      sessions.verify(phoneConnection, "bob").pipe(Effect.result)
    );
    expect(Result.isFailure(result) && result.failure.operation).toBe(
      "identity"
    );
    expect(lookupDeviceKey).toHaveBeenCalledOnce();
  });

  it("requires RPC verification again after disconnect", async () => {
    const { lookupDeviceKey, sessions } = fixture();
    await Effect.runPromise(sessions.verify(phoneConnection, "alice"));
    sessions.closed(phoneConnection);
    sessions.opened(phoneConnection);
    lookupDeviceKey.mockReturnValueOnce(
      Effect.fail(new RegistryReaderError({ operation: "rpc" }))
    );
    const result = await Effect.runPromise(
      sessions.verify(phoneConnection, "alice").pipe(Effect.result)
    );
    expect(Result.isFailure(result) && result.failure.operation).toBe("rpc");
    expect(sessions.isVerified(phoneConnection, "1")).toBe(false);
    await Effect.runPromise(sessions.verify(phoneConnection, "alice"));
    expect(lookupDeviceKey).toHaveBeenCalledTimes(3);
  });

  it("does not restore authorization when an old lookup finishes after reconnect", async () => {
    const { lookupDeviceKey, sessions, upsertContact } = fixture();
    const pending = Promise.withResolvers<RegistryAccount>();
    lookupDeviceKey.mockReturnValueOnce(Effect.promise(() => pending.promise));
    const result = Effect.runPromise(
      sessions.verify(phoneConnection, "alice").pipe(Effect.result)
    );
    await vi.waitFor(() => expect(lookupDeviceKey).toHaveBeenCalledOnce());
    sessions.closed(phoneConnection);
    sessions.opened(phoneConnection);
    pending.resolve(phoneAccount());
    const denied = await result;
    expect(Result.isFailure(denied) && denied.failure.operation).toBe("closed");
    expect(upsertContact).not.toHaveBeenCalled();
    expect(sessions.isVerified(phoneConnection, "1")).toBe(false);
  });

  it("clears authorization on endpoint shutdown", async () => {
    const { sessions } = fixture();
    await Effect.runPromise(sessions.verify(phoneConnection, "alice"));
    sessions.clear();
    expect(sessions.isVerified(phoneConnection, "1")).toBe(false);
    const result = await Effect.runPromise(
      sessions.verify(phoneConnection, "alice").pipe(Effect.result)
    );
    expect(Result.isFailure(result) && result.failure.operation).toBe("closed");
  });

  it("rejects an absent account and an unexpected qid", async () => {
    const { lookupDeviceKey, lookupHandle, sessions, upsertContact } =
      fixture();
    lookupDeviceKey.mockReturnValueOnce(Effect.succeed(null));
    const absent = await Effect.runPromise(
      sessions.verify(phoneConnection, "alice").pipe(Effect.result)
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
      sessions.verify(phoneConnection, "bob").pipe(Effect.result)
    );
    expect(Result.isFailure(result) && result.failure.operation).toBe(
      "identity"
    );
    expect(lookupDeviceKey).toHaveBeenCalledWith(phoneDeviceKey);
    expect(upsertContact).not.toHaveBeenCalled();
  });

  it("maps contact storage failures to storage and does not cache authorization", async () => {
    const { getContactByQid, lookupDeviceKey, sessions, upsertContact } =
      fixture();
    getContactByQid.mockRejectedValueOnce(new Error("db read failed"));
    const readFailed = await Effect.runPromise(
      sessions.verify(phoneConnection, "alice").pipe(Effect.result)
    );
    expect(Result.isFailure(readFailed) && readFailed.failure.operation).toBe(
      "storage"
    );
    expect(sessions.isVerified(phoneConnection, "1")).toBe(false);
    expect(upsertContact).not.toHaveBeenCalled();

    getContactByQid.mockResolvedValue(contact);
    upsertContact.mockRejectedValueOnce(new Error("db write failed"));
    const writeFailed = await Effect.runPromise(
      sessions.verify(phoneConnection, "alice").pipe(Effect.result)
    );
    expect(Result.isFailure(writeFailed) && writeFailed.failure.operation).toBe(
      "storage"
    );
    expect(sessions.isVerified(phoneConnection, "1")).toBe(false);
    expect(lookupDeviceKey).toHaveBeenCalledTimes(2);

    upsertContact.mockResolvedValue();
    await expect(
      Effect.runPromise(sessions.verify(phoneConnection, "alice"))
    ).resolves.toMatchObject({ qid: "1" });
    expect(sessions.isVerified(phoneConnection, "1")).toBe(true);
  });

  it("does not refresh auth age when a successful lookup is stale", async () => {
    const { advance, lookupDeviceKey, sessions } = fixture();
    await Effect.runPromise(sessions.verify(cliConnection, "alice"));
    expect(sessions.isVerified(cliConnection, "1")).toBe(true);

    advance(MAX_AUTH_AGE_MS);
    lookupDeviceKey.mockReturnValue(
      Effect.succeed({
        ...phoneAccount(),
        // Still shows CLI membership, but the RPC view is stale/cached.
        freshness: "stale",
      })
    );
    const refused = await Effect.runPromise(
      sessions.verify(cliConnection, "alice").pipe(Effect.result)
    );
    expect(Result.isFailure(refused) && refused.failure.operation).toBe(
      "identity"
    );
    expect(sessions.isVerified(cliConnection, "1")).toBe(false);
  });

  it("does not refresh auth age when a fresh lookup returns the same block", async () => {
    const { advance, lookupDeviceKey, sessions } = fixture();
    await Effect.runPromise(sessions.verify(cliConnection, "alice"));
    expect(sessions.isVerified(cliConnection, "1")).toBe(true);

    advance(MAX_AUTH_AGE_MS);
    lookupDeviceKey.mockReturnValue(
      Effect.succeed({
        ...phoneAccount(),
        blockNumber: 1n,
        freshness: "fresh",
      })
    );
    const refused = await Effect.runPromise(
      sessions.verify(cliConnection, "alice").pipe(Effect.result)
    );
    expect(Result.isFailure(refused) && refused.failure.operation).toBe(
      "identity"
    );
    expect(sessions.isVerified(cliConnection, "1")).toBe(false);
  });

  it("does refresh auth age when a fresh lookup advances the block", async () => {
    const { advance, lookupDeviceKey, sessions } = fixture();
    await Effect.runPromise(sessions.verify(cliConnection, "alice"));
    advance(MAX_AUTH_AGE_MS);
    lookupDeviceKey.mockReturnValue(
      Effect.succeed({
        ...phoneAccount(),
        blockNumber: 2n,
        freshness: "fresh",
      })
    );
    await expect(
      Effect.runPromise(sessions.verify(cliConnection, "alice"))
    ).resolves.toMatchObject({ qid: "1" });
    expect(sessions.isVerified(cliConnection, "1")).toBe(true);
  });

  it("does not grant another 60s on retry of the same stale block after rejection", async () => {
    const { advance, lookupDeviceKey, sessions } = fixture();
    await Effect.runPromise(sessions.verify(cliConnection, "alice"));
    expect(sessions.isVerified(cliConnection, "1")).toBe(true);

    advance(MAX_AUTH_AGE_MS);
    lookupDeviceKey.mockReturnValue(
      Effect.succeed({
        ...phoneAccount(),
        blockNumber: 1n,
        freshness: "fresh",
      })
    );
    const first = await Effect.runPromise(
      sessions.verify(cliConnection, "alice").pipe(Effect.result)
    );
    expect(Result.isFailure(first) && first.failure.operation).toBe("identity");
    expect(sessions.isVerified(cliConnection, "1")).toBe(false);

    // Retrying the identical stuck head must still fail — rejection must not
    // erase remembered freshness history with the cleared authorization.
    const second = await Effect.runPromise(
      sessions.verify(cliConnection, "alice").pipe(Effect.result)
    );
    expect(Result.isFailure(second) && second.failure.operation).toBe(
      "identity"
    );
    expect(sessions.isVerified(cliConnection, "1")).toBe(false);
  });

  it("rejects stuck same-head membership after resume invalidate", async () => {
    const { lookupDeviceKey, sessions } = fixture();
    await Effect.runPromise(sessions.verify(cliConnection, "alice"));
    expect(sessions.isVerified(cliConnection, "1")).toBe(true);

    sessions.invalidateAuthorization();
    expect(sessions.isVerified(cliConnection, "1")).toBe(false);

    // Stuck/cached RPC replaying the pre-resume head must not remint auth.
    lookupDeviceKey.mockReturnValue(
      Effect.succeed({
        ...phoneAccount(),
        blockNumber: 1n,
        freshness: "fresh",
      })
    );
    const refused = await Effect.runPromise(
      sessions.verify(cliConnection, "alice").pipe(Effect.result)
    );
    expect(Result.isFailure(refused) && refused.failure.operation).toBe(
      "identity"
    );
    expect(sessions.isVerified(cliConnection, "1")).toBe(false);
  });

  it("re-authorizes after resume only with a strictly newer live head", async () => {
    const { lookupDeviceKey, sessions } = fixture();
    await Effect.runPromise(sessions.verify(cliConnection, "alice"));
    sessions.invalidateAuthorization();

    lookupDeviceKey.mockReturnValue(
      Effect.succeed({
        ...phoneAccount(),
        blockNumber: 2n,
        freshness: "fresh",
      })
    );
    await expect(
      Effect.runPromise(sessions.verify(cliConnection, "alice"))
    ).resolves.toMatchObject({ qid: "1" });
    expect(sessions.isVerified(cliConnection, "1")).toBe(true);
  });

  it("rejects stale-tagged membership after resume even at a newer head", async () => {
    const { lookupDeviceKey, sessions } = fixture();
    await Effect.runPromise(sessions.verify(cliConnection, "alice"));
    sessions.invalidateAuthorization();

    lookupDeviceKey.mockReturnValue(
      Effect.succeed({
        ...phoneAccount(),
        blockNumber: 2n,
        freshness: "stale",
      })
    );
    const refused = await Effect.runPromise(
      sessions.verify(cliConnection, "alice").pipe(Effect.result)
    );
    expect(Result.isFailure(refused) && refused.failure.operation).toBe(
      "identity"
    );
    expect(sessions.isVerified(cliConnection, "1")).toBe(false);
  });

  it("drops in-flight verify that finishes after resume invalidation", async () => {
    let clock = 0;
    const { getContactByQid, lookupDeviceKey, sessions } = fixture({
      now: () => clock,
    });
    await Effect.runPromise(sessions.verify(cliConnection, "alice"));
    expect(sessions.isVerified(cliConnection, "1")).toBe(true);

    clock = MAX_AUTH_AGE_MS;
    lookupDeviceKey.mockReturnValue(
      Effect.succeed({
        ...phoneAccount(),
        blockNumber: 2n,
        freshness: "fresh",
      })
    );

    const contactGate = Promise.withResolvers<Contact | null>();
    getContactByQid.mockReturnValue(contactGate.promise);

    const inFlight = Effect.runPromise(
      sessions.verify(cliConnection, "alice").pipe(Effect.result)
    );

    // Resume invalidation must cancel the writer even if storage later succeeds.
    sessions.invalidateAuthorization();
    expect(sessions.isVerified(cliConnection, "1")).toBe(false);

    contactGate.resolve(contact);
    const finished = await inFlight;
    expect(Result.isFailure(finished) && finished.failure.operation).toBe(
      "closed"
    );
    expect(sessions.isVerified(cliConnection, "1")).toBe(false);
  });

  it("rejects after resume invalidate when the device was revoked during sleep", async () => {
    const { lookupDeviceKey, sessions } = fixture();
    await Effect.runPromise(sessions.verify(cliConnection, "alice"));
    expect(sessions.isVerified(cliConnection, "1")).toBe(true);

    sessions.invalidateAuthorization();
    expect(sessions.isVerified(cliConnection, "1")).toBe(false);

    lookupDeviceKey.mockReturnValue(Effect.succeed(null));
    const refused = await Effect.runPromise(
      sessions.verify(cliConnection, "alice").pipe(Effect.result)
    );
    expect(Result.isFailure(refused) && refused.failure.operation).toBe(
      "identity"
    );
    expect(sessions.isVerified(cliConnection, "1")).toBe(false);
    // Phone session never confirmed before resume, so it has no prior head —
    // first live confirm at block 1 is allowed. (CLI history still blocks 1n.)
    lookupDeviceKey.mockImplementation((deviceKey: string) => {
      if (deviceKey === phoneDeviceKey) {
        return Effect.succeed({
          ...phoneAccount(),
          blockNumber: 1n,
          devices: [{ deviceKey: phoneDeviceKey, peerId: PEER_ALICE }],
          freshness: "fresh",
        });
      }
      return Effect.succeed(null);
    });
    await expect(
      Effect.runPromise(sessions.verify(phoneConnection, "alice"))
    ).resolves.toMatchObject({ peerId: PEER_ALICE });
  });

  it("fails both phone and CLI sessions after a recovery wipe", async () => {
    const { lookupDeviceKey, sessions } = fixture();
    await Effect.runPromise(sessions.verify(phoneConnection, "alice"));
    await Effect.runPromise(sessions.verify(cliConnection, "alice"));
    expect(sessions.isVerified(phoneConnection, "1")).toBe(true);
    expect(sessions.isVerified(cliConnection, "1")).toBe(true);

    sessions.invalidateAuthorization();
    lookupDeviceKey.mockReturnValue(Effect.succeed(null));

    const phoneRefused = await Effect.runPromise(
      sessions.verify(phoneConnection, "alice").pipe(Effect.result)
    );
    const cliRefused = await Effect.runPromise(
      sessions.verify(cliConnection, "alice").pipe(Effect.result)
    );
    expect(
      Result.isFailure(phoneRefused) && phoneRefused.failure.operation
    ).toBe("identity");
    expect(Result.isFailure(cliRefused) && cliRefused.failure.operation).toBe(
      "identity"
    );
    expect(sessions.isVerified(phoneConnection, "1")).toBe(false);
    expect(sessions.isVerified(cliConnection, "1")).toBe(false);
  });
});
