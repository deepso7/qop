import { Hex32, peerIdFromDeviceKey, PeerId } from "@qop/identity";
import { Effect, Result, Schema } from "effect";
import { keccak256, toBytes } from "viem";
import { describe, expect, it, vi } from "vitest";

import { createRegistryReader } from "@/lib/registry-core";

const DEVICE_KEY = `0x${"22".repeat(32)}`;
const OWNER = "0x7E5F4552091A69125D5DfCb7b8C2659029395BDF";
const ALICE_HASH = keccak256(toBytes("alice"));

describe("registry reader", () => {
  it("looks up a handle and derives its peer ID from the device key", async () => {
    const readContract = vi.fn(({ functionName, args }) => {
      if (functionName === "qidByHandleHash") {
        return Promise.resolve(args[0] === ALICE_HASH ? 42n : 0n);
      }
      if (functionName === "account") {
        return Promise.resolve([
          OWNER,
          DEVICE_KEY,
          3,
          1_700_000_000n,
          0n,
          "alice",
        ] as const);
      }
      return Promise.resolve(0n);
    });
    const { lookupHandle } = createRegistryReader({ client: { readContract } });
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
  });

  it("rejects an account with an all-zero device key", async () => {
    const readContract = vi.fn(({ functionName }) =>
      Promise.resolve(
        functionName === "qidByHandleHash"
          ? 42n
          : ([
              OWNER,
              `0x${"00".repeat(32)}`,
              3,
              1_700_000_000n,
              0n,
              "alice",
            ] as const)
      )
    );
    const { lookupHandle } = createRegistryReader({ client: { readContract } });

    const result = await Effect.runPromise(
      lookupHandle("alice").pipe(Effect.result)
    );

    expect(Result.isFailure(result) && result.failure.operation).toBe("decode");
  });
});
