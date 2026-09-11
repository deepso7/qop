import { Effect, Result } from "effect";
import { describe, expect, it, vi } from "vitest";

import { submitWipeDevices } from "@/lib/registry-write-core";

describe("registry wipe submit", () => {
  it("submits wipeDevices with the signed intent", async () => {
    const writeContract = vi.fn(async () => "0xabc" as const);
    const hash = await Effect.runPromise(
      submitWipeDevices({
        client: { writeContract },
        registryAddress: "0x1111111111111111111111111111111111111111",
        submission: {
          deadline: 1_700_003_600n,
          nonce: 13n,
          qid: 42n,
          signature: `0x${"ab".repeat(65)}`,
        },
        wipeAbi: [],
      })
    );
    expect(hash).toBe("0xabc");
    expect(writeContract).toHaveBeenCalledWith({
      abi: [],
      address: "0x1111111111111111111111111111111111111111",
      args: [
        { deadline: 1_700_003_600n, nonce: 13n, qid: 42n },
        `0x${"ab".repeat(65)}`,
      ],
      functionName: "wipeDevices",
    });
  });

  it("maps write failures to rpc", async () => {
    const result = await Effect.runPromise(
      submitWipeDevices({
        client: {
          writeContract: async () => {
            throw new Error("rpc down");
          },
        },
        registryAddress: "0x1111111111111111111111111111111111111111",
        submission: {
          deadline: 1n,
          nonce: 0n,
          qid: 1n,
          signature: `0x${"00".repeat(65)}`,
        },
        wipeAbi: [],
      }).pipe(Effect.result)
    );
    expect(Result.isFailure(result) && result.failure.operation).toBe("rpc");
  });
});
