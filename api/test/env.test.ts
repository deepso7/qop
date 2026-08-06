import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { decodeEnv } from "../src/env.ts";

describe("api environment", () => {
  it.effect("normalizes a checksummed registry address", () =>
    Effect.gen(function* () {
      const env = yield* decodeEnv({
        CHAIN_ID: "31337",
        DATABASE_URL: "postgresql://user:password@localhost:5432/qop",
        REGISTRY_ADDRESS: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
        REGISTRY_CONFIRMATIONS: "12",
        RPC_URL: "http://127.0.0.1:8545",
      });

      assert.strictEqual(
        env.REGISTRY_ADDRESS,
        "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
      );
    })
  );
});
