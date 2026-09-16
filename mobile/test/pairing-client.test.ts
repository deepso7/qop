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
  extras: Partial<PairingTransport> & Pick<PairingTransport, "connectAddr">
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

  it("tries the next advertised address when connectAddr rejects", async () => {
    const offer = await Effect.runPromise(
      Schema.decodeUnknownEffect(PairingOfferV1)({
        ...encodedOffer,
        addrs: [LAN, "/ip4/10.0.0.8/udp/4001/quic-v1"],
      })
    );
    const peerId = await Effect.runPromise(expectedPeerId());
    const attempted: string[] = [];
    const result = await Effect.runPromise(
      handshakePairing(
        handshakeTransport(peerId, {
          connectAddr: (address) => {
            attempted.push(address);
            if (address === LAN) {
              return Promise.reject(
                new Error("peer id protocol must be terminal")
              );
            }
            return Promise.resolve({ peerId });
          },
        }),
        offer,
        {
          chainId: encodedOffer.chainId,
          qid: encodedOffer.qid,
          registry: encodedOffer.registry,
        },
        () => Promise.resolve(new Uint8Array(32).fill(7))
      )
    );
    expect(result.peerId).toBe(peerId);
    expect(attempted).toEqual([LAN, "/ip4/10.0.0.8/udp/4001/quic-v1"]);
  });

  it("dials by expected peer id instead of connectAddr for circuit offers", async () => {
    const offer = await Effect.runPromise(
      Schema.decodeUnknownEffect(PairingOfferV1)({
        ...encodedOffer,
        addrs: [CIRCUIT, LAN],
      })
    );
    const peerId = await Effect.runPromise(expectedPeerId());
    const connectAddr = vi.fn(() =>
      Promise.reject(new Error("peer id protocol must be terminal"))
    );
    const connect = vi.fn(() => Promise.resolve({ peerId }));
    const result = await Effect.runPromise(
      handshakePairing(
        handshakeTransport(peerId, {
          connect,
          connectAddr,
        }),
        offer,
        {
          chainId: encodedOffer.chainId,
          qid: encodedOffer.qid,
          registry: encodedOffer.registry,
        },
        () => Promise.resolve(new Uint8Array(32).fill(7))
      )
    );
    expect(result.peerId).toBe(peerId);
    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith(peerId);
    expect(connectAddr).not.toHaveBeenCalled();
  });

  it("uses advertised addresses as hints when connectWithAddrs is available", async () => {
    const offer = await Effect.runPromise(
      Schema.decodeUnknownEffect(PairingOfferV1)({
        ...encodedOffer,
        addrs: [CIRCUIT, LAN],
      })
    );
    const peerId = await Effect.runPromise(expectedPeerId());
    const connectAddr = vi.fn(() => Promise.reject(new Error("unused")));
    const connectWithAddrs = vi.fn(() => Promise.resolve({ peerId }));
    const result = await Effect.runPromise(
      handshakePairing(
        handshakeTransport(peerId, {
          connectAddr,
          connectWithAddrs,
        }),
        offer,
        {
          chainId: encodedOffer.chainId,
          qid: encodedOffer.qid,
          registry: encodedOffer.registry,
        },
        () => Promise.resolve(new Uint8Array(32).fill(7))
      )
    );
    expect(result.peerId).toBe(peerId);
    expect(connectWithAddrs).toHaveBeenCalledExactlyOnceWith(peerId, [
      CIRCUIT,
      LAN,
    ]);
    expect(connectAddr).not.toHaveBeenCalled();
  });

  it("skips circuit connectAddr and still reaches a later LAN address", async () => {
    const offer = await Effect.runPromise(
      Schema.decodeUnknownEffect(PairingOfferV1)({
        ...encodedOffer,
        addrs: [CIRCUIT, LAN],
      })
    );
    const peerId = await Effect.runPromise(expectedPeerId());
    const attempted: string[] = [];
    const result = await Effect.runPromise(
      handshakePairing(
        handshakeTransport(peerId, {
          connectAddr: (address) => {
            attempted.push(address);
            return Promise.resolve({ peerId });
          },
        }),
        offer,
        {
          chainId: encodedOffer.chainId,
          qid: encodedOffer.qid,
          registry: encodedOffer.registry,
        },
        () => Promise.resolve(new Uint8Array(32).fill(7))
      )
    );
    expect(result.peerId).toBe(peerId);
    expect(attempted).toEqual([LAN]);
  });
});
