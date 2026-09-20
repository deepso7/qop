import { Hex32, PeerId, peerIdFromDeviceKey } from "@qop/identity";
import { Deferred, Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";

import { createRegistryReader } from "../src/registry-reader.ts";

const DEVICE_KEY = `0x${"22".repeat(32)}` as const;
const OWNER = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const HEAD = 99n;

const accountResult = {
  handle: "alice",
  nonce: 0n,
  owner: OWNER,
  ownerVersion: 3,
  registeredAt: 1_700_000_000n,
};

describe("registry reader accountAt", () => {
  it("issues account and listActiveDevices concurrently at the pinned head", async () => {
    const started: string[] = [];
    const accountHold = Deferred.makeUnsafe<boolean>();
    const devicesHold = Deferred.makeUnsafe<boolean>();
    const { lookupQid } = createRegistryReader({
      client: {
        getBlockNumber: () => Promise.resolve(HEAD),
        readContract: async ({ blockNumber, functionName }) => {
          if (functionName === "account") {
            expect(blockNumber).toBe(HEAD);
            started.push(functionName);
            await Effect.runPromise(Deferred.await(accountHold));
            return accountResult;
          }
          if (functionName === "listActiveDevices") {
            expect(blockNumber).toBe(HEAD);
            started.push(functionName);
            await Effect.runPromise(Deferred.await(devicesHold));
            return [DEVICE_KEY];
          }
          throw new Error(`unexpected ${functionName}`);
        },
      },
    });

    const lookup = Effect.runPromise(lookupQid(42n));
    await vi.waitFor(() => {
      expect(started).toEqual(
        expect.arrayContaining(["account", "listActiveDevices"])
      );
      expect(started).toHaveLength(2);
    });
    Effect.runSync(Deferred.succeed(accountHold, true));
    Effect.runSync(Deferred.succeed(devicesHold, true));

    const deviceKey = await Effect.runPromise(
      Schema.decodeUnknownEffect(Hex32)(DEVICE_KEY)
    );
    const peerId = await Effect.runPromise(
      peerIdFromDeviceKey(deviceKey).pipe(
        Effect.flatMap(Schema.encodeEffect(PeerId))
      )
    );
    await expect(lookup).resolves.toEqual({
      blockNumber: HEAD,
      deviceKey: DEVICE_KEY,
      devices: [{ deviceKey: DEVICE_KEY, peerId }],
      freshness: "fresh",
      handle: "alice",
      nonce: 0n,
      owner: OWNER.toLowerCase(),
      ownerVersion: 3,
      peerId,
      qid: 42n,
      registeredAt: 1_700_000_000n,
    });
  });
});
