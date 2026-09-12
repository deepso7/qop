import { Hex32, peerIdFromDeviceKey, PeerId } from "@qop/identity";
import {
  asHex,
  asQidString,
  decodePairingOfferV1,
  PAIR_PROTOCOL,
  pairingFingerprint,
  readPairingFrame,
  writePairingFrame,
} from "@qop/protocol";
import type {
  DeviceActionApprovalV1Encoded,
  PairingOfferV1,
} from "@qop/protocol";
import { Data, Effect, Schema } from "effect";

export class PhonePairingError extends Data.TaggedError("PhonePairingError")<{
  readonly operation:
    | "ack"
    | "connect"
    | "mismatch"
    | "offer"
    | "peer"
    | "stream";
}> {}

export interface PairingStream {
  readonly closeWrite: () => void;
  readonly peerId: string;
  readonly protocolId: string;
  readonly read: () => Promise<Uint8Array | undefined>;
  readonly reset: () => void;
  readonly write: (data: Uint8Array) => void;
}

export interface PairingTransport {
  readonly connectAddr: (
    address: string
  ) => Promise<{ readonly peerId: string }>;
  readonly openPairingStream: (peerId: string) => Promise<PairingStream>;
  readonly waitPeerReady: (peerId: string) => Promise<void>;
}

export interface LocalPairingConfig {
  readonly chainId: string;
  readonly qid: string;
  readonly registry: string;
}

const pairingError = (operation: PhonePairingError["operation"]) =>
  new PhonePairingError({ operation });

const deviceKeyBytes = (value: string | Uint8Array) =>
  value instanceof Uint8Array
    ? Effect.succeed(value)
    : Schema.decodeUnknownEffect(Hex32)(value).pipe(
        Effect.mapError(() => pairingError("offer"))
      );

const randomChallenge = Effect.fn("PhonePairing.randomChallenge")(function* () {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return yield* Schema.encodeEffect(Hex32)(bytes);
});

export const decodePairingPayload = (payload: string, nowSeconds: bigint) =>
  decodePairingOfferV1(payload, nowSeconds).pipe(
    Effect.mapError(() => pairingError("offer"))
  );

export const assertOfferMatchesAccount = (
  offer: PairingOfferV1,
  local: LocalPairingConfig
) => {
  if (
    asQidString(offer.chainId) !== local.chainId ||
    offer.registry !== local.registry ||
    asQidString(offer.qid) !== local.qid
  ) {
    return Effect.fail(pairingError("mismatch"));
  }
  return Effect.void;
};

const expectedPeerId = Effect.fn("PhonePairing.expectedPeerId")(function* (
  offer: PairingOfferV1
) {
  const bytes = yield* deviceKeyBytes(offer.deviceKey);
  return yield* peerIdFromDeviceKey(bytes).pipe(
    Effect.flatMap(Schema.encodeEffect(PeerId)),
    Effect.mapError(() => pairingError("peer"))
  );
});

const dialOffer = Effect.fn("PhonePairing.dialOffer")(function* (
  transport: PairingTransport,
  offer: PairingOfferV1,
  peerId: string
) {
  const tryAddr = (index: number): Effect.Effect<string, PhonePairingError> =>
    Effect.gen(function* () {
      const address = offer.addrs[index];
      if (!address) {
        return yield* pairingError("connect");
      }
      const connected = yield* Effect.tryPromise({
        catch: () => pairingError("connect"),
        try: () => transport.connectAddr(address),
      });
      if (connected.peerId !== peerId) {
        return yield* tryAddr(index + 1);
      }
      yield* Effect.tryPromise({
        catch: () => pairingError("connect"),
        try: () => transport.waitPeerReady(peerId),
      });
      return peerId;
    });
  return yield* tryAddr(0);
});

export const handshakePairing = Effect.fn("PhonePairing.handshake")(function* (
  transport: PairingTransport,
  offer: PairingOfferV1,
  local: LocalPairingConfig
) {
  yield* assertOfferMatchesAccount(offer, local);
  const peerId = yield* expectedPeerId(offer);
  yield* dialOffer(transport, offer, peerId);
  const stream = yield* Effect.tryPromise({
    catch: () => pairingError("stream"),
    try: () => transport.openPairingStream(peerId),
  });
  if (stream.peerId !== peerId || stream.protocolId !== PAIR_PROTOCOL) {
    stream.reset();
    return yield* pairingError("peer");
  }
  const challenge = yield* randomChallenge();
  yield* writePairingFrame(
    (data) => stream.write(data),
    () => stream.closeWrite(),
    {
      challenge,
      secret: offer.secret,
      sessionId: offer.sessionId,
      type: "hello",
      v: 1,
    }
  );
  const ack = yield* readPairingFrame(() => stream.read());
  if (
    ack.type !== "helloAck" ||
    asHex(ack.challenge) !== asHex(challenge) ||
    asHex(ack.deviceKey) !== asHex(offer.deviceKey) ||
    asHex(ack.sessionId) !== asHex(offer.sessionId) ||
    asQidString(ack.qid) !== asQidString(offer.qid) ||
    ack.registry !== offer.registry
  ) {
    stream.reset();
    return yield* pairingError("mismatch");
  }
  return {
    fingerprint: pairingFingerprint(asHex(offer.deviceKey)),
    peerId,
  };
});

export const sendPairingApproval = Effect.fn("PhonePairing.sendApproval")(
  function* (
    transport: PairingTransport,
    offer: PairingOfferV1,
    peerId: string,
    record: DeviceActionApprovalV1Encoded
  ) {
    const stream = yield* Effect.tryPromise({
      catch: () => pairingError("stream"),
      try: () => transport.openPairingStream(peerId),
    });
    if (stream.peerId !== peerId) {
      stream.reset();
      return yield* pairingError("peer");
    }
    yield* writePairingFrame(
      (data) => stream.write(data),
      () => stream.closeWrite(),
      {
        record,
        sessionId: offer.sessionId,
        type: "approval",
        v: 1,
      }
    );
    const ack = yield* readPairingFrame(() => stream.read());
    if (ack.type === "approvalConflict") {
      return yield* pairingError("ack");
    }
    if (ack.type !== "approvalSaved" || ack.digest !== record.digest) {
      return yield* pairingError("ack");
    }
    return ack.digest;
  }
);
