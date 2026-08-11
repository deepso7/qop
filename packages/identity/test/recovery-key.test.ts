import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  decodeRecoveryKeyV1,
  encodeRecoveryKeyV1,
  ownerAddressFromRecoveryKeyV1,
} from "../src/index.ts";

const PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 1]);
const SECP256K1_ORDER = Uint8Array.from([
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xfe, 0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2,
  0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
]);
const SECP256K1_MAX_PRIVATE_KEY = Uint8Array.from(SECP256K1_ORDER);
SECP256K1_MAX_PRIVATE_KEY[31] = 0x40;
const ZERO_PAYLOAD = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ORDER_PAYLOAD = "_____________________rqu3OavSKA7v9JejNA2QUE";

describe("qop recovery keys", () => {
  it.effect("round-trips a checksummed owner key", () =>
    Effect.gen(function* () {
      const recoveryKey = yield* encodeRecoveryKeyV1(PRIVATE_KEY);
      assert.strictEqual(
        recoveryKey,
        "qop1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE_b3764897"
      );
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

  it.effect("accepts the largest valid secp256k1 owner key", () =>
    Effect.gen(function* () {
      const recoveryKey = yield* encodeRecoveryKeyV1(SECP256K1_MAX_PRIVATE_KEY);
      assert.deepStrictEqual(
        yield* decodeRecoveryKeyV1(recoveryKey),
        SECP256K1_MAX_PRIVATE_KEY
      );
    })
  );

  it.effect("rejects invalid owner material during encoding", () =>
    Effect.gen(function* () {
      const invalidPrivateKeys = [
        new Uint8Array(31),
        new Uint8Array(33),
        new Uint8Array(32),
        SECP256K1_ORDER,
        new Uint8Array(32).fill(0xff),
      ];

      for (const privateKey of invalidPrivateKeys) {
        const error = yield* encodeRecoveryKeyV1(privateKey).pipe(Effect.flip);
        assert.strictEqual(error.operation, "encode");
      }
    })
  );

  it.effect("rejects malformed recovery-key strings", () =>
    Effect.gen(function* () {
      const valid = yield* encodeRecoveryKeyV1(PRIVATE_KEY);
      const payload = valid.slice(5, 48);
      const malformed: readonly unknown[] = [
        null,
        1,
        valid.replace("qop1_", "qop2_"),
        valid.slice(0, -1),
        valid.replace(payload[0] ?? "A", "!"),
        `${valid.slice(0, -1)}A`,
        `qop1_${payload.slice(0, -1)}F_${valid.slice(-8)}`,
      ];

      for (const recoveryKey of malformed) {
        const error = yield* decodeRecoveryKeyV1(recoveryKey).pipe(Effect.flip);
        assert.strictEqual(error.operation, "decode");
      }
    })
  );

  it.effect("rejects invalid owner material during decoding", () =>
    Effect.gen(function* () {
      for (const payload of [ZERO_PAYLOAD, ORDER_PAYLOAD]) {
        const error = yield* decodeRecoveryKeyV1(
          `qop1_${payload}_00000000`
        ).pipe(Effect.flip);
        assert.strictEqual(error.operation, "decode");
      }
    })
  );

  it.effect("rejects a modified checksum", () =>
    Effect.gen(function* () {
      const recoveryKey = yield* encodeRecoveryKeyV1(PRIVATE_KEY);
      const modified = `${recoveryKey.slice(0, -1)}${recoveryKey.endsWith("0") ? "1" : "0"}`;
      const checksumError = yield* decodeRecoveryKeyV1(modified).pipe(
        Effect.flip
      );
      assert.strictEqual(checksumError.operation, "decode");
    })
  );
});
