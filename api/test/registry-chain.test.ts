import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  decodeFunctionResult,
  encodeAbiParameters,
  parseAbiParameters,
} from "viem";

import { registryReadAbi } from "../src/registry/abi.ts";
import {
  confirmedRegistryBlock,
  RegistryChainError,
} from "../src/registry/chain.ts";

describe("registry confirmed block", () => {
  it("decodes the Solidity account struct, including its dynamic handle", () => {
    const owner = "0x1111111111111111111111111111111111111111";
    const deviceKey = `0x${"22".repeat(32)}` as const;
    // account() returns one Account struct, so its dynamic tuple has an outer offset.
    // Define the wire shape independently from the ABI used by the reader.
    const data = encodeAbiParameters(
      parseAbiParameters("(address, bytes32, uint32, uint64, uint256, string)"),
      [[owner, deviceKey, 3, 1_700_000_000n, 7n, "alice"]]
    );

    assert.deepStrictEqual(
      decodeFunctionResult({
        abi: registryReadAbi,
        data,
        functionName: "account",
      }),
      {
        deviceKey,
        handle: "alice",
        nonce: 7n,
        owner,
        ownerVersion: 3,
        registeredAt: 1_700_000_000n,
      }
    );
  });

  it.effect("fails closed before the configured confirmation depth", () =>
    Effect.gen(function* () {
      const error = yield* confirmedRegistryBlock(11n, 12n).pipe(Effect.flip);

      assert.instanceOf(error, RegistryChainError);
      assert.strictEqual(error.operation, "confirmed-block");
    })
  );

  it.effect("accepts the exact boundary and zero-confirmation reads", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* confirmedRegistryBlock(12n, 12n), 0n);
      assert.strictEqual(yield* confirmedRegistryBlock(12n, 0n), 12n);
    })
  );
});
