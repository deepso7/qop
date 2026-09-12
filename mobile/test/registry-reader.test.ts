import { Hex32, peerIdFromDeviceKey, PeerId } from "@qop/identity";
import { Effect, Result, Schema } from "effect";
import {
  decodeFunctionResult,
  encodeAbiParameters,
  keccak256,
  toBytes,
} from "viem";
import { describe, expect, it, vi } from "vitest";

import { createRegistryReader, registryAbi } from "@/lib/registry-core";

const DEVICE_KEY = `0x${"22".repeat(32)}` as const;
const CLI_KEY = `0x${"33".repeat(32)}` as const;
const OWNER = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const ALICE_HASH = keccak256(toBytes("alice"));

describe("registry reader", () => {
  it("looks up handles and device keys across multiple active devices", async () => {
    const readContract = vi.fn(({ functionName, args }) => {
      if (functionName === "qidByHandleHash") {
        return Promise.resolve(args[0] === ALICE_HASH ? 42n : 0n);
      }
      if (functionName === "qidByDeviceKey") {
        return Promise.resolve(
          args[0] === DEVICE_KEY || args[0] === CLI_KEY ? 42n : 0n
        );
      }
      if (functionName === "listActiveDevices") {
        return Promise.resolve([DEVICE_KEY, CLI_KEY]);
      }
      if (functionName === "account") {
        const data = encodeAbiParameters(
          [
            {
              components: [
                { type: "address" },
                { type: "uint32" },
                { type: "uint64" },
                { type: "uint256" },
                { type: "string" },
              ],
              type: "tuple",
            },
          ],
          [[OWNER, 3, 1_700_000_000n, 0n, "alice"]]
        );
        return Promise.resolve(
          decodeFunctionResult({
            abi: registryAbi,
            data,
            functionName: "account",
          })
        );
      }
      return Promise.resolve(0n);
    });
    const { listActiveDevices, lookupDeviceKey, lookupHandle } =
      createRegistryReader({
        client: { readContract },
      });
    const deviceKey = await Effect.runPromise(
      Schema.decodeUnknownEffect(Hex32)(DEVICE_KEY)
    );
    const cliKey = await Effect.runPromise(
      Schema.decodeUnknownEffect(Hex32)(CLI_KEY)
    );
    const expectedPeerId = await Effect.runPromise(
      peerIdFromDeviceKey(deviceKey).pipe(
        Effect.flatMap(Schema.encodeEffect(PeerId))
      )
    );
    const expectedCliPeerId = await Effect.runPromise(
      peerIdFromDeviceKey(cliKey).pipe(
        Effect.flatMap(Schema.encodeEffect(PeerId))
      )
    );

    await expect(Effect.runPromise(lookupHandle("bob"))).resolves.toBeNull();
    await expect(Effect.runPromise(lookupHandle("alice"))).resolves.toEqual({
      blockNumber: 0n,
      deviceKey: DEVICE_KEY,
      devices: [
        { deviceKey: DEVICE_KEY, peerId: expectedPeerId },
        { deviceKey: CLI_KEY, peerId: expectedCliPeerId },
      ],
      freshness: "stale",
      handle: "alice",
      owner: OWNER.toLowerCase(),
      ownerVersion: 3,
      peerId: expectedPeerId,
      qid: 42n,
      registeredAt: 1_700_000_000n,
    });
    await expect(Effect.runPromise(lookupDeviceKey(CLI_KEY))).resolves.toEqual({
      blockNumber: 0n,
      deviceKey: CLI_KEY,
      devices: [
        { deviceKey: DEVICE_KEY, peerId: expectedPeerId },
        { deviceKey: CLI_KEY, peerId: expectedCliPeerId },
      ],
      freshness: "stale",
      handle: "alice",
      owner: OWNER.toLowerCase(),
      ownerVersion: 3,
      peerId: expectedCliPeerId,
      qid: 42n,
      registeredAt: 1_700_000_000n,
    });
    await expect(Effect.runPromise(listActiveDevices(42n))).resolves.toEqual([
      { deviceKey: DEVICE_KEY, peerId: expectedPeerId },
      { deviceKey: CLI_KEY, peerId: expectedCliPeerId },
    ]);
  });

  it("rejects an active device list that includes an all-zero device key", async () => {
    const readContract = vi.fn(({ functionName }) => {
      if (functionName === "qidByHandleHash") {
        return Promise.resolve(42n);
      }
      if (functionName === "listActiveDevices") {
        return Promise.resolve([`0x${"00".repeat(32)}`]);
      }
      return Promise.resolve({
        handle: "alice",
        nonce: 0n,
        owner: OWNER,
        ownerVersion: 3,
        registeredAt: 1_700_000_000n,
      });
    });
    const { lookupHandle } = createRegistryReader({ client: { readContract } });

    const result = await Effect.runPromise(
      lookupHandle("alice").pipe(Effect.result)
    );

    expect(Result.isFailure(result) && result.failure.operation).toBe("decode");
  });

  it("aborts the RPC when its lookup fiber is interrupted", async () => {
    const pending = Promise.withResolvers<bigint>();
    let aborted = false;
    const { lookupHandle } = createRegistryReader({
      client: {
        readContract: (_parameters, { signal } = {}) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
          });
          return pending.promise;
        },
      },
    });

    const result = await Effect.runPromise(
      lookupHandle("alice").pipe(Effect.timeoutOption(0))
    );
    expect(result._tag).toBe("None");
    expect(aborted).toBe(true);
  });

  it("returns null when the preferred device key is absent from the active list", async () => {
    const removedKey = `0x${"44".repeat(32)}` as const;
    const readContract = vi.fn(({ functionName, args }) => {
      if (functionName === "qidByDeviceKey") {
        return Promise.resolve(args[0] === removedKey ? 42n : 0n);
      }
      if (functionName === "listActiveDevices") {
        return Promise.resolve([DEVICE_KEY, CLI_KEY]);
      }
      if (functionName === "account") {
        return Promise.resolve({
          handle: "alice",
          nonce: 0n,
          owner: OWNER,
          ownerVersion: 3,
          registeredAt: 1_700_000_000n,
        });
      }
      return Promise.resolve(0n);
    });
    const { lookupDeviceKey } = createRegistryReader({
      client: { readContract },
    });
    await expect(
      Effect.runPromise(lookupDeviceKey(removedKey))
    ).resolves.toBeNull();
  });

  it("pins membership reads to a non-deduped head and labels them fresh", async () => {
    const getBlockNumber = vi.fn(() => Promise.resolve(99n));
    const readContract = vi.fn(({ functionName, blockNumber, args }) => {
      expect(blockNumber).toBe(99n);
      if (functionName === "qidByDeviceKey") {
        return Promise.resolve(args[0] === DEVICE_KEY ? 42n : 0n);
      }
      if (functionName === "listActiveDevices") {
        return Promise.resolve([DEVICE_KEY]);
      }
      if (functionName === "account") {
        return Promise.resolve({
          handle: "alice",
          nonce: 0n,
          owner: OWNER,
          ownerVersion: 3,
          registeredAt: 1_700_000_000n,
        });
      }
      return Promise.resolve(0n);
    });
    const { lookupDeviceKey } = createRegistryReader({
      client: { getBlockNumber, readContract },
    });
    await expect(
      Effect.runPromise(lookupDeviceKey(DEVICE_KEY))
    ).resolves.toMatchObject({
      blockNumber: 99n,
      freshness: "fresh",
      handle: "alice",
    });
    expect(getBlockNumber).toHaveBeenCalled();
    expect(
      readContract.mock.calls.every(([{ blockNumber }]) => blockNumber === 99n)
    ).toBe(true);
  });

  it("labels membership stale when the client cannot provide a block head", async () => {
    const readContract = vi.fn(({ functionName, blockNumber, args }) => {
      expect(blockNumber).toBeUndefined();
      if (functionName === "qidByDeviceKey") {
        return Promise.resolve(args[0] === DEVICE_KEY ? 42n : 0n);
      }
      if (functionName === "listActiveDevices") {
        return Promise.resolve([DEVICE_KEY]);
      }
      if (functionName === "account") {
        return Promise.resolve({
          handle: "alice",
          nonce: 0n,
          owner: OWNER,
          ownerVersion: 3,
          registeredAt: 1_700_000_000n,
        });
      }
      return Promise.resolve(0n);
    });
    const { lookupDeviceKey } = createRegistryReader({
      client: { readContract },
    });
    await expect(
      Effect.runPromise(lookupDeviceKey(DEVICE_KEY))
    ).resolves.toMatchObject({
      blockNumber: 0n,
      freshness: "stale",
    });
  });
});
