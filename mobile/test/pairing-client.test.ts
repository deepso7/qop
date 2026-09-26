import { Hex32, PeerId, peerIdFromDeviceKey } from "@qop/identity";
import { PAIR_PROTOCOL, PairingOfferV1 } from "@qop/protocol";
import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";

import { handshakePairing, PhonePairingError } from "@/lib/pairing-client-core";
import type { PairingTransport } from "@/lib/pairing-client-core";

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

const CIRCUIT =
  "/dns/relay.example/udp/4001/quic-v1/p2p/relay/p2p-circuit/p2p/12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X";
const LAN = "/ip4/192.168.1.10/udp/4001/quic-v1";

const expectedPeerId = () =>
  Schema.decodeUnknownEffect(Hex32)(encodedOffer.deviceKey).pipe(
    Effect.flatMap(peerIdFromDeviceKey),
    Effect.flatMap(Schema.encodeEffect(PeerId))
  );

const helloAckChunks = () => [
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

const handshakeTransport = (
  peerId: string,
  extras: Partial<PairingTransport> & Pick<PairingTransport, "connect">
): PairingTransport => {
  const chunks = helloAckChunks();
  return {
    openPairingStream: () =>
      Promise.resolve({
        closeWrite: () => {},
        peerId,
        protocolId: PAIR_PROTOCOL,
        read: () => Promise.resolve(chunks.shift()),
        reset: () => {},
        write: () => {},
      }),
    waitPeerReady: () => Promise.resolve(),
    ...extras,
  };
};

describe("phone pairing handshake", () => {
  it("uses the supplied native random source without a Web Crypto global", async () => {
    const offer = await Effect.runPromise(
      Schema.decodeUnknownEffect(PairingOfferV1)(encodedOffer)
    );
    const peerId = await Effect.runPromise(expectedPeerId());
    const writes: Uint8Array[] = [];
    const chunks = helloAckChunks();
    const randomBytes = vi.fn(() =>
      Promise.resolve(new Uint8Array(32).fill(7))
    );
    vi.stubGlobal("crypto", null);
    try {
      const result = await Effect.runPromise(
        handshakePairing(
          handshakeTransport(peerId, {
            connect: () => Promise.resolve({ peerId }),
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
          }),
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
          connect: () => Promise.reject(new Error("unused")),
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

  const handshakeWith = async (
    addrs: readonly string[],
    connect: PairingTransport["connect"]
  ) => {
    const offer = await Effect.runPromise(
      Schema.decodeUnknownEffect(PairingOfferV1)({ ...encodedOffer, addrs })
    );
    const peerId = await Effect.runPromise(expectedPeerId());
    return Effect.runPromise(
      handshakePairing(
        handshakeTransport(peerId, { connect }),
        offer,
        {
          chainId: encodedOffer.chainId,
          qid: encodedOffer.qid,
          registry: encodedOffer.registry,
        },
        () => Promise.resolve(new Uint8Array(32).fill(7))
      )
    );
  };

  it("dials the direct offer addresses as one target without circuits", async () => {
    const peerId = await Effect.runPromise(expectedPeerId());
    const connect = vi.fn(() => Promise.resolve({ peerId }));
    const result = await handshakeWith([CIRCUIT, LAN], connect);
    expect(result.peerId).toBe(peerId);
    expect(connect).toHaveBeenCalledExactlyOnceWith([LAN]);
  });

  it("dials by peer id when the offer only has circuit addresses", async () => {
    const peerId = await Effect.runPromise(expectedPeerId());
    const connect = vi.fn(() => Promise.resolve({ peerId }));
    const result = await handshakeWith([CIRCUIT], connect);
    expect(result.peerId).toBe(peerId);
    expect(connect).toHaveBeenCalledExactlyOnceWith(peerId);
  });
});
