import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  decodePairingFrameV1,
  decodePairingOfferV1,
  encodePairingFrameV1,
  encodePairingOfferV1,
  PairingCodecError,
  PairingFrameV1,
  PairingOfferV1,
} from "../src/pairing.ts";

const encodedOffer = {
  addrs: [
    "/ip4/127.0.0.1/udp/4001/quic-v1/p2p/12D3KooWC7cDcNR4J3NC9y1gTkqafZKmnjCUvrRMxU2LMugGJGgy",
  ],
  chainId: "31337",
  deviceKey: `0x${"09".repeat(32)}`,
  expiresAt: "1700003600",
  qid: "42",
  registry: "0x1111111111111111111111111111111111111111",
  secret: `0x${"11".repeat(32)}`,
  sessionId: `0x${"22".repeat(32)}`,
  v: 1 as const,
};

describe("pairing codecs", () => {
  it.effect(
    "round-trips a QR offer and rejects expiry or unknown versions",
    () =>
      Effect.gen(function* () {
        const offer =
          yield* Schema.decodeUnknownEffect(PairingOfferV1)(encodedOffer);
        const payload = yield* encodePairingOfferV1(offer);
        const decoded = yield* decodePairingOfferV1(payload, 1_700_000_000n);
        assert.strictEqual(decoded.qid.toString(), "42");
        assert.strictEqual(decoded.addrs.length, 1);

        const expired = yield* decodePairingOfferV1(
          payload,
          1_700_003_600n
        ).pipe(Effect.result);
        assert.strictEqual(
          expired._tag === "Failure" &&
            expired.failure instanceof PairingCodecError &&
            expired.failure.operation === "expired",
          true
        );

        const version = yield* decodePairingOfferV1("qop-pair2.abc", 1n).pipe(
          Effect.result
        );
        assert.strictEqual(
          version._tag === "Failure" &&
            version.failure instanceof PairingCodecError &&
            version.failure.operation === "version",
          true
        );
      })
  );

  it.effect("round-trips pairing frames including approvalSaved", () =>
    Effect.gen(function* () {
      const encoded = {
        digest: `0x${"ab".repeat(32)}`,
        sessionId: `0x${"22".repeat(32)}`,
        type: "approvalSaved" as const,
        v: 1 as const,
      };
      const frame = yield* Schema.decodeUnknownEffect(PairingFrameV1)(encoded);
      const bytes = yield* encodePairingFrameV1(frame);
      const decoded = yield* decodePairingFrameV1(bytes);
      assert.strictEqual(decoded.type, "approvalSaved");
      if (decoded.type === "approvalSaved") {
        assert.strictEqual(decoded.digest, encoded.digest);
      }
    })
  );
});
