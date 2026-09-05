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

  it("caches a chain ID mismatch across handle and owner lookups", async () => {
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

  it("passes cancellation through the configured viem client to fetch", async () => {
    const pending = Promise.withResolvers<Response>();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      // SAFETY: viem's HTTP transport serializes every JSON-RPC request as an object with a method.
      const request = JSON.parse(String(init?.body)) as { method: string };
      if (request.method === "eth_chainId") {
        return Promise.resolve(
          Response.json({ id: 0, jsonrpc: "2.0", result: "0x7a69" })
        );
      }
      expect(request.method).toBe("eth_call");
      init?.signal?.addEventListener("abort", () => {
        pending.reject(init.signal?.reason);
      });
      return pending.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv(
      "EXPO_PUBLIC_REGISTRY_ADDRESS",
      "0x1111111111111111111111111111111111111111"
    );
    vi.stubEnv("EXPO_PUBLIC_REGISTRY_CHAIN_ID", "31337");
    vi.stubEnv("EXPO_PUBLIC_RPC_URL", "https://rpc.qop.test");
    try {
      vi.resetModules();
      const { lookupOwner } = await import("@/lib/registry");
      const result = await Effect.runPromise(
        lookupOwner("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf").pipe(
          Effect.timeoutOption(20)
        )
      );
      expect(result._tag).toBe("None");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
        signal: expect.objectContaining({ aborted: true }),
      });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
