import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { registryReadAbi } from "../src/registry/abi.ts";
import {
  confirmedRegistryBlock,
  RegistryChainError,
} from "../src/registry/chain.ts";

describe("registry confirmed block", () => {
  it("uses the device-key account tuple and has no revocation read", () => {
    const account = registryReadAbi.find((entry) => entry.name === "account");
    assert.deepStrictEqual(
      account && "outputs" in account
        ? account.outputs.map(({ name, type }) => ({ name, type }))
        : undefined,
      [
        { name: "owner", type: "address" },
        { name: "deviceKey", type: "bytes32" },
        { name: "ownerVersion", type: "uint32" },
        { name: "registeredAt", type: "uint64" },
        { name: "nonce", type: "uint256" },
        { name: "handle", type: "string" },
      ]
    );
    assert.deepStrictEqual(
      registryReadAbi.map((entry) => entry.name),
      ["account", "qidByHandleHash", "qidByOwner", "registrationNonceUsed"]
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
