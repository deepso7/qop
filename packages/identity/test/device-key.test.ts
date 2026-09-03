import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { bytesToHex } from "viem";

import {
  deviceKeyFromEd25519SecretKey,
  deviceKeyFromPeerId,
  peerIdFromDeviceKey,
  peerIdFromEd25519SecretKey,
  PeerId,
} from "../src/index.ts";

const SECRET_KEY = new Uint8Array(32).fill(1);

describe("device keys", () => {
  it.effect("derives a stable device key and MiniP2P PeerId", () =>
    Effect.gen(function* () {
      const deviceKey = yield* deviceKeyFromEd25519SecretKey(SECRET_KEY);
      const peerId = yield* peerIdFromEd25519SecretKey(SECRET_KEY);
      const encodedPeerId = yield* Schema.encodeEffect(PeerId)(peerId);

      assert.strictEqual(deviceKey.length, 32);
      assert.strictEqual(
        bytesToHex(deviceKey),
        "0x8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"
      );
      assert.strictEqual(encodedPeerId.length, 52);
      assert.isTrue(encodedPeerId.startsWith("12D3KooW"));
      assert.deepStrictEqual(yield* peerIdFromDeviceKey(deviceKey), peerId);
      assert.deepStrictEqual(yield* deviceKeyFromPeerId(peerId), deviceKey);
    })
  );

  it.effect("rejects a malformed Ed25519 secret key", () =>
    Effect.gen(function* () {
      const error = yield* deviceKeyFromEd25519SecretKey(
        new Uint8Array(31)
      ).pipe(Effect.flip);
      assert.strictEqual(error.operation, "derive-public-key");
    })
  );
});
