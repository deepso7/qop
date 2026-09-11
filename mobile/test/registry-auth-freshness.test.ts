import { Effect, Result } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { Contact } from "@/lib/db";
import {
  createPeerSessions,
  MAX_AUTH_AGE_MS,
} from "@/lib/p2p-sessions";
import {
  createRegistryReader,
  type RegistryAccount,
} from "@/lib/registry-core";

const PEER_ALICE = "12D3KooWC7cDcNR4J3NC9y1gTkqafZKmnjCUvrRMxU2LMugGJGgy";
const PEER_CLI = "12D3KooWDGEF3VLEM7R3XWGJsqPCcSSjwRmuNw6JTQMVMNSSzwAz";

const phoneDeviceKey = `0x${"22".repeat(32)}` as const;
const cliDeviceKey = `0x${"33".repeat(32)}` as const;
const OWNER = "0x0000000000000000000000000000000000000001";

const contact: Contact = {
  createdAt: 1_700_000_000_000,
  deviceKey: phoneDeviceKey,
  handle: "alice",
  keyChanged: false,
  lastReadAt: 42,
  owner: OWNER,
  peerId: PEER_ALICE,
  qid: "1",
};

const cliConnection = { connId: 2, peerId: PEER_CLI };

const membershipAccount = ({
  functionName,
  args,
}: {
  functionName: string;
  args: readonly unknown[];
}) => {
  if (functionName === "qidByDeviceKey") {
    return args[0] === phoneDeviceKey || args[0] === cliDeviceKey ? 1n : 0n;
  }
  if (functionName === "listActiveDevices") {
    return [phoneDeviceKey, cliDeviceKey];
  }
  if (functionName === "account") {
    return {
      handle: "alice",
      nonce: 0n,
      owner: OWNER,
      ownerVersion: 0,
      registeredAt: 1_700_000_000n,
    };
  }
  return 0n;
};

/**
 * Production-path proof: freshness is produced by createRegistryReader
 * (pinned head), not by a session mock injecting freshness: "stale".
 */
describe("registry reader auth freshness", () => {
  it("does not extend live auth when the reader keeps returning the same head", async () => {
    let head = 10n;
    const getBlockNumber = vi.fn(async () => head);
    const readContract = vi.fn(async (parameters) => {
      expect(parameters.blockNumber).toBe(head);
      return membershipAccount(parameters);
    });

    const reader = createRegistryReader({
      client: { getBlockNumber, readContract },
    });

    let clock = 0;
    const sessions = createPeerSessions({
      getContactByQid: async () => contact,
      lookupDeviceKey: (deviceKey) => reader.lookupDeviceKey(deviceKey),
      lookupHandle: (handle) => reader.lookupHandle(handle),
      now: () => clock,
      upsertContact: async () => {},
    });
    sessions.opened(cliConnection);

    await Effect.runPromise(sessions.verify(cliConnection, "alice"));
    expect(sessions.isVerified(cliConnection, "1")).toBe(true);
    expect(getBlockNumber).toHaveBeenCalled();

    // Age out. Reader still reports membership at the same head (stuck RPC).
    clock += MAX_AUTH_AGE_MS;
    const refused = await Effect.runPromise(
      sessions.verify(cliConnection, "alice").pipe(Effect.result)
    );
    expect(Result.isFailure(refused) && refused.failure.operation).toBe(
      "identity"
    );
    expect(sessions.isVerified(cliConnection, "1")).toBe(false);

    // A newer head is a real confirm and may refresh.
    head = 11n;
    await expect(
      Effect.runPromise(sessions.verify(cliConnection, "alice"))
    ).resolves.toMatchObject({ qid: "1" });
    expect(sessions.isVerified(cliConnection, "1")).toBe(true);
  });

  it("does not remint auth after resume when the reader replays the same head", async () => {
    let head = 10n;
    const getBlockNumber = vi.fn(async () => head);
    const readContract = vi.fn(async (parameters) => {
      expect(parameters.blockNumber).toBe(head);
      return membershipAccount(parameters);
    });

    const reader = createRegistryReader({
      client: { getBlockNumber, readContract },
    });

    let clock = 0;
    const sessions = createPeerSessions({
      getContactByQid: async () => contact,
      lookupDeviceKey: (deviceKey) => reader.lookupDeviceKey(deviceKey),
      lookupHandle: (handle) => reader.lookupHandle(handle),
      now: () => clock,
      upsertContact: async () => {},
    });
    sessions.opened(cliConnection);

    await Effect.runPromise(sessions.verify(cliConnection, "alice"));
    expect(sessions.isVerified(cliConnection, "1")).toBe(true);

    // Resume clears auth but preserves lastConfirmedBlockNumber.
    sessions.invalidateAuthorization();
    expect(sessions.isVerified(cliConnection, "1")).toBe(false);

    // Reader still at the same head (stuck/cached RPC) — must not remint.
    const stuck = await Effect.runPromise(
      sessions.verify(cliConnection, "alice").pipe(Effect.result)
    );
    expect(Result.isFailure(stuck) && stuck.failure.operation).toBe("identity");
    expect(sessions.isVerified(cliConnection, "1")).toBe(false);

    // A newer live head may restore auth.
    head = 11n;
    await expect(
      Effect.runPromise(sessions.verify(cliConnection, "alice"))
    ).resolves.toMatchObject({ qid: "1" });
    expect(sessions.isVerified(cliConnection, "1")).toBe(true);
  });

  it("marks untagged reader lookups stale so sessions refuse to mint auth age", async () => {
    const readContract = vi.fn(async (parameters) => {
      expect(parameters.blockNumber).toBeUndefined();
      return membershipAccount(parameters);
    });
    const reader = createRegistryReader({ client: { readContract } });
    const account = await Effect.runPromise(
      reader.lookupDeviceKey(cliDeviceKey)
    );
    expect(account).toMatchObject({
      blockNumber: 0n,
      freshness: "stale",
    } satisfies Partial<RegistryAccount>);

    const sessions = createPeerSessions({
      getContactByQid: async () => contact,
      lookupDeviceKey: (deviceKey) => reader.lookupDeviceKey(deviceKey),
      lookupHandle: (handle) => reader.lookupHandle(handle),
      now: () => 0,
      upsertContact: async () => {},
    });
    sessions.opened(cliConnection);
    const refused = await Effect.runPromise(
      sessions.verify(cliConnection, "alice").pipe(Effect.result)
    );
    expect(Result.isFailure(refused) && refused.failure.operation).toBe(
      "identity"
    );
    expect(sessions.isVerified(cliConnection, "1")).toBe(false);
  });
});
