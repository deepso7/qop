import { Effect, Result } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  submitRecoverOwner,
  submitWipeDevices,
} from "@/lib/registry-write-core";

describe("registry write submit", () => {
  it("submits wipeDevices with the signed intent", async () => {
    const writeContract = vi.fn(() => Promise.resolve("0xabc" as const));
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

  it("maps wipe write failures to rpc", async () => {
    const result = await Effect.runPromise(
      submitWipeDevices({
        client: {
          writeContract: () => Promise.reject(new Error("rpc down")),
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

  it("submits recoverOwner with owner and newOwner signatures", async () => {
    const writeContract = vi.fn(() => Promise.resolve("0xdef" as const));
    const hash = await Effect.runPromise(
      submitRecoverOwner({
        client: { writeContract },
        recoverAbi: [],
        registryAddress: "0x1111111111111111111111111111111111111111",
        submission: {
          deadline: 1_700_003_600n,
          newOwner: "0x2222222222222222222222222222222222222222",
          newOwnerSignature: `0x${"cd".repeat(65)}`,
          nonce: 13n,
          ownerSignature: `0x${"ab".repeat(65)}`,
          qid: 42n,
        },
      })
    );
    expect(hash).toBe("0xdef");
    expect(writeContract).toHaveBeenCalledWith({
      abi: [],
      address: "0x1111111111111111111111111111111111111111",
      args: [
        {
          deadline: 1_700_003_600n,
          newOwner: "0x2222222222222222222222222222222222222222",
          nonce: 13n,
          qid: 42n,
        },
        `0x${"ab".repeat(65)}`,
        `0x${"cd".repeat(65)}`,
      ],
      functionName: "recoverOwner",
    });
  });
});
