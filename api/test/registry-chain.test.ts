import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  confirmedRegistryBlock,
  RegistryChainError,
} from "../src/registry/chain.ts";

describe("registry confirmed block", () => {
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
