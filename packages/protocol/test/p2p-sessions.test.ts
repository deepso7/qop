import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  createPeerSessions,
  PeerVerificationError,
} from "../src/p2p-sessions.ts";
import type { RegistryAccount } from "../src/registry-reader.ts";

const PEER_ALICE = "12D3KooWC7cDcNR4J3NC9y1gTkqafZKmnjCUvrRMxU2LMugGJGgy";
const PEER_CLI = "12D3KooWDGEF3VLEM7R3XWGJsqPCcSSjwRmuNw6JTQMVMNSSzwAz";
const phoneDeviceKey = `0x${"22".repeat(32)}`;
const cliDeviceKey = `0x${"33".repeat(32)}`;

const account = (): RegistryAccount => ({
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

const contact = { handle: "alice", qid: "1" };

describe("recipientPeerIds account hints", () => {
  it("makes zero lookupHandle calls when an account is supplied", async () => {
    const lookupHandle = vi.fn(() => Effect.succeed(account()));
    const sessions = createPeerSessions({
      getContactByQid: () => Promise.resolve(null),
      lookupDeviceKey: () => Effect.succeed(account()),
      lookupHandle,
      upsertContact: () => Promise.resolve(),
    });
    await expect(
      Effect.runPromise(sessions.recipientPeerIds(contact, account()))
    ).resolves.toEqual([PEER_ALICE, PEER_CLI]);
    expect(lookupHandle).not.toHaveBeenCalled();
  });

  it("fails identity when the passed account handle or qid does not match", async () => {
    const lookupHandle = vi.fn(() => Effect.succeed(account()));
    const sessions = createPeerSessions({
      getContactByQid: () => Promise.resolve(null),
      lookupDeviceKey: () => Effect.succeed(account()),
      lookupHandle,
      upsertContact: () => Promise.resolve(),
    });
    const mismatched = { ...account(), handle: "bob", qid: 99n };
    const result = await Effect.runPromise(
      sessions.recipientPeerIds(contact, mismatched).pipe(Effect.result)
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(PeerVerificationError);
      expect(result.failure.operation).toBe("identity");
    }
    expect(lookupHandle).not.toHaveBeenCalled();
  });
});
