import { Effect, Result } from "effect";
import { describe, expect, it, vi } from "vitest";

import { createConfiguredRegistry } from "@/lib/registry";

describe("configured registry", () => {
  it("retries transient initialization failures and caches success", async () => {
    const getChainId = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(31_337);
    const readContract = vi.fn().mockResolvedValue(0n);
    const { lookupHandle } = createConfiguredRegistry({
      createClient: () => ({ getChainId, readContract }),
      registryAddress: "0x1111111111111111111111111111111111111111",
      registryChainId: "31337",
      rpcUrl: "https://rpc.qop.test",
    });
    const failed = await Effect.runPromise(
      lookupHandle("alice").pipe(Effect.result)
    );
    expect(Result.isFailure(failed) && failed.failure.operation).toBe("rpc");
    await expect(Effect.runPromise(lookupHandle("alice"))).resolves.toBeNull();
    await expect(Effect.runPromise(lookupHandle("bob"))).resolves.toBeNull();
    expect(getChainId).toHaveBeenCalledTimes(2);
  });

  it("rejects a chain ID mismatch before reading accounts", async () => {
    const getChainId = vi.fn().mockResolvedValue(1);
    const readContract = vi.fn().mockResolvedValue(0n);
    const createClient = vi.fn(() => ({ getChainId, readContract }));
    const { lookupHandle, lookupOwner } = createConfiguredRegistry({
      createClient,
      registryAddress: "0x1111111111111111111111111111111111111111",
      registryChainId: "31337",
      rpcUrl: "https://rpc.qop.test",
    });

    const first = await Effect.runPromise(
      lookupHandle("alice").pipe(Effect.result)
    );
    const second = await Effect.runPromise(
      lookupOwner("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf").pipe(
        Effect.result
      )
    );

    expect(Result.isFailure(first) && first.failure.operation).toBe(
      "configuration"
    );
    expect(Result.isFailure(second) && second.failure.operation).toBe(
      "configuration"
    );
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(getChainId).toHaveBeenCalledTimes(2);
    expect(readContract).not.toHaveBeenCalled();
  });
});
