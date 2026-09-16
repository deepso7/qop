import { Hex32, PeerId, peerIdFromDeviceKey } from "@qop/identity";
import { PAIR_PROTOCOL, PairingOfferV1 } from "@qop/protocol";
import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";

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
  it("uses the supplied native random source without a Web Crypto global", async () => {
    const offer = await Effect.runPromise(
      Schema.decodeUnknownEffect(PairingOfferV1)(encodedOffer)
    );
    const peerId = await Effect.runPromise(
      Schema.decodeUnknownEffect(Hex32)(encodedOffer.deviceKey).pipe(
        Effect.flatMap(peerIdFromDeviceKey),
        Effect.flatMap(Schema.encodeEffect(PeerId))
      )
    );
    const challenge = new Uint8Array(32).fill(7);
    const writes: Uint8Array[] = [];
    const chunks: (Uint8Array | undefined)[] = [
      new TextEncoder().encode(
        JSON.stringify({
          chainId: encodedOffer.chainId,
          challenge: `0x${"07".repeat(32)}`,
          deviceKey: encodedOffer.deviceKey,
          qid: encodedOffer.qid,
          registry: encodedOffer.registry,
          sessionId: encodedOffer.sessionId,
          type: "helloAck",
          v: 1,
        })
      ),
      undefined,
    ];
    const randomBytes = vi.fn(() => Promise.resolve(challenge));
    vi.stubGlobal("crypto", null);
    try {
      const result = await Effect.runPromise(
        handshakePairing(
          {
            connectAddr: () => Promise.resolve({ peerId }),
            openPairingStream: () =>
              Promise.resolve({
                closeWrite: () => {},
                peerId,
                protocolId: PAIR_PROTOCOL,
                read: () => Promise.resolve(chunks.shift()),
                reset: () => {},
                write: (bytes) => {
                  writes.push(bytes);
                },
              }),
            waitPeerReady: () => Promise.resolve(),
          },
          offer,
          {
            chainId: encodedOffer.chainId,
            qid: encodedOffer.qid,
            registry: encodedOffer.registry,
          },
          randomBytes
        )
      );
      expect(result.peerId).toBe(peerId);
      expect(randomBytes).toHaveBeenCalledOnce();
      expect(JSON.parse(new TextDecoder().decode(writes[0]))).toMatchObject({
        challenge: `0x${"07".repeat(32)}`,
        type: "hello",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

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
        },
        () => Promise.resolve(new Uint8Array(32))
      ).pipe(Effect.result)
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(PhonePairingError);
    }
  });
});
