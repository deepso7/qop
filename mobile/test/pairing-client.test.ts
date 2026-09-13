import { PairingOfferV1 } from "@qop/protocol";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { handshakePairing, PhonePairingError } from "@/lib/pairing-client-core";

const encodedOffer = {
  addrs: ["/ip4/127.0.0.1/udp/4001/quic-v1"],
  chainId: "31337",
  deviceKey: `0x${"09".repeat(32)}`,
  expiresAt: "1700003600",
  qid: "42",
  registry: "0x1111111111111111111111111111111111111111",
  secret: `0x${"11".repeat(32)}`,
  sessionId: `0x${"22".repeat(32)}`,
  v: 1 as const,
};

describe("phone pairing handshake", () => {
  it("rejects a pairing offer for the wrong account", async () => {
    const offer = await Effect.runPromise(
      Schema.decodeUnknownEffect(PairingOfferV1)(encodedOffer)
    );
    const result = await Effect.runPromise(
      handshakePairing(
        {
          connectAddr: () => Promise.reject(new Error("unused")),
          openPairingStream: () => Promise.reject(new Error("unused")),
          waitPeerReady: () => Promise.resolve(),
        },
        offer,
        {
          chainId: "31337",
          qid: "99",
          registry: encodedOffer.registry,
        }
      ).pipe(Effect.result)
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(PhonePairingError);
    }
  });
});
