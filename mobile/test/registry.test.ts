import { Effect, Result } from "effect";
import { describe, expect, it, vi } from "vitest";

import { createConfiguredRegistry } from "@/lib/registry";

describe("configured registry", () => {
  it("caches a chain ID mismatch as a configuration failure", async () => {
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
    expect(createClient).toHaveBeenCalledOnce();
    expect(getChainId).toHaveBeenCalledOnce();
    expect(readContract).not.toHaveBeenCalled();
  });
});
