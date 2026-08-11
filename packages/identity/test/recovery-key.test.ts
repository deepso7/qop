import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  decodeRecoveryKeyV1,
  encodeRecoveryKeyV1,
  ownerAddressFromRecoveryKeyV1,
} from "../src/index.ts";

const PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 1]);

describe("qop recovery keys", () => {
  it.effect("round-trips a checksummed owner key", () =>
    Effect.gen(function* () {
      const recoveryKey = yield* encodeRecoveryKeyV1(PRIVATE_KEY);
      assert.strictEqual(
        recoveryKey,
        "qop1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE_b3764897"
      );
      assert.match(recoveryKey, /^qop1_[A-Za-z0-9_-]{43}_[0-9a-f]{8}$/u);
      assert.deepStrictEqual(
        yield* decodeRecoveryKeyV1(recoveryKey),
        PRIVATE_KEY
      );
    })
  );

  it.effect("derives the canonical owner address", () =>
    Effect.gen(function* () {
      const recoveryKey = yield* encodeRecoveryKeyV1(PRIVATE_KEY);
      assert.strictEqual(
        yield* ownerAddressFromRecoveryKeyV1(recoveryKey),
        "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
      );
    })
  );

  it.effect("rejects invalid owner material and modified recovery keys", () =>
    Effect.gen(function* () {
      const zeroKeyError = yield* encodeRecoveryKeyV1(new Uint8Array(32)).pipe(
        Effect.flip
      );
      assert.strictEqual(zeroKeyError.operation, "encode");

      const recoveryKey = yield* encodeRecoveryKeyV1(PRIVATE_KEY);
      const modified = `${recoveryKey.slice(0, -1)}${recoveryKey.endsWith("0") ? "1" : "0"}`;
      const checksumError = yield* decodeRecoveryKeyV1(modified).pipe(
        Effect.flip
      );
      assert.strictEqual(checksumError.operation, "decode");
    })
  );
});
