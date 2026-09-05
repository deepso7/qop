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
const OWNER = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const ALICE_HASH = keccak256(toBytes("alice"));

describe("registry reader", () => {
  it("looks up a handle and derives its peer ID from the device key", async () => {
    const readContract = vi.fn(({ functionName, args }) => {
      if (functionName === "qidByHandleHash") {
        return Promise.resolve(args[0] === ALICE_HASH ? 42n : 0n);
      }
      if (functionName === "qidByDeviceKey") {
        return Promise.resolve(args[0] === DEVICE_KEY ? 42n : 0n);
      }
      if (functionName === "account") {
        // Encode Solidity's dynamic struct return independently of the reader ABI.
        const data = encodeAbiParameters(
          [
            {
              components: [
                { type: "address" },
                { type: "bytes32" },
                { type: "uint32" },
                { type: "uint64" },
                { type: "uint256" },
                { type: "string" },
              ],
              type: "tuple",
            },
          ],
          [[OWNER, DEVICE_KEY, 3, 1_700_000_000n, 0n, "alice"]]
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
    const { lookupDeviceKey, lookupHandle } = createRegistryReader({
      client: { readContract },
    });
    const deviceKey = await Effect.runPromise(
      Schema.decodeUnknownEffect(Hex32)(DEVICE_KEY)
    );
    const expectedPeerId = await Effect.runPromise(
      peerIdFromDeviceKey(deviceKey).pipe(
        Effect.flatMap(Schema.encodeEffect(PeerId))
      )
    );

    await expect(Effect.runPromise(lookupHandle("bob"))).resolves.toBeNull();
    await expect(Effect.runPromise(lookupHandle("alice"))).resolves.toEqual({
      deviceKey: DEVICE_KEY,
      handle: "alice",
      owner: OWNER.toLowerCase(),
      ownerVersion: 3,
      peerId: expectedPeerId,
      qid: 42n,
      registeredAt: 1_700_000_000n,
    });
    await expect(
      Effect.runPromise(lookupDeviceKey(DEVICE_KEY))
    ).resolves.toEqual({
      deviceKey: DEVICE_KEY,
      handle: "alice",
      owner: OWNER.toLowerCase(),
      ownerVersion: 3,
      peerId: expectedPeerId,
      qid: 42n,
      registeredAt: 1_700_000_000n,
    });
  });

  it("rejects an account with an all-zero device key", async () => {
    const readContract = vi.fn(({ functionName }) =>
      Promise.resolve(
        functionName === "qidByHandleHash"
          ? 42n
          : {
              deviceKey: `0x${"00".repeat(32)}`,
              handle: "alice",
              nonce: 0n,
              owner: OWNER,
              ownerVersion: 3,
              registeredAt: 1_700_000_000n,
            }
      )
    );
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
});
