import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { readPairingFrame, writePairingFrame } from "../src/pairing-io.ts";
import { encodePairingFrameV1, PairingFrameV1 } from "../src/pairing.ts";

describe("pairing stream frames", () => {
  it.effect("writes then reads a half-closed approvalSaved frame", () =>
    Effect.gen(function* () {
      const encoded = {
        digest: `0x${"ab".repeat(32)}`,
        sessionId: `0x${"22".repeat(32)}`,
        type: "approvalSaved" as const,
        v: 1 as const,
      };
      const frame = yield* Schema.decodeUnknownEffect(PairingFrameV1)(encoded);
      const chunks: Uint8Array[] = [];
      yield* writePairingFrame(
        (data) => {
          chunks.push(data);
        },
        () => {},
        frame
      );
      const pending = [...chunks, undefined];
      const decoded = yield* readPairingFrame(() =>
        Promise.resolve(pending.shift())
      );
      assert.strictEqual(decoded.type, "approvalSaved");
      yield* encodePairingFrameV1(frame);
    })
  );
});
