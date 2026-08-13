import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { bytesToHex } from "viem";

import { encryptionPublicKeyFromSecretKey } from "../src/index.ts";

describe("device encryption keys", () => {
  it.effect("derives a stable X25519 public key", () =>
    Effect.gen(function* () {
      const secretKey = Uint8Array.from([...new Uint8Array(31), 1]);
      const publicKey = yield* encryptionPublicKeyFromSecretKey(secretKey);

      assert.strictEqual(publicKey.length, 32);
      assert.strictEqual(
        bytesToHex(publicKey),
        "0xfd3384e132ad02a56c78f45547ee40038dc79002b90d29ed90e08eee762ae715"
      );
    })
  );

  it.effect("rejects malformed X25519 secret keys", () =>
    Effect.gen(function* () {
      for (const secretKey of [new Uint8Array(31), new Uint8Array(33)]) {
        const error = yield* encryptionPublicKeyFromSecretKey(secretKey).pipe(
          Effect.flip
        );
        assert.strictEqual(error.operation, "derive-public-key");
      }
    })
  );
});
