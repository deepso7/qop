import {
  ChainId,
  EthereumAddress,
  Hex32,
  Qid,
  UnixSeconds,
} from "@qop/identity";
import { base64urlnopad } from "@scure/base";
import { Data, Effect, Schema } from "effect";

import { DeviceActionApprovalV1 } from "./approval.ts";
import {
  PAIRING_FRAME_MAX_BYTES,
  PAIRING_MAX_ADDRESSES,
  PAIRING_QR_MAX_CHARS,
} from "./limits.ts";

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

const CanonicalHex32 = Hex32.pipe(Schema.decodeTo(Hex32.pipe(Schema.flip)));
const CanonicalQid = Qid.pipe(Schema.decodeTo(Qid.pipe(Schema.flip)));
const CanonicalChainId = ChainId.pipe(
  Schema.decodeTo(ChainId.pipe(Schema.flip))
);
const CanonicalDeadline = UnixSeconds.pipe(
  Schema.decodeTo(UnixSeconds.pipe(Schema.flip))
);

const Multiaddr = Schema.String.check(
  Schema.isLengthBetween(1, 256),
  Schema.makeFilter((value) => value.startsWith("/"), {
    expected: "a multiaddr beginning with /",
  })
);

export const PairingOfferV1Schema = Schema.Struct({
  addrs: Schema.Array(Multiaddr).check(
    Schema.isLengthBetween(1, PAIRING_MAX_ADDRESSES)
  ),
  chainId: CanonicalChainId,
  deviceKey: CanonicalHex32,
  expiresAt: CanonicalDeadline,
  qid: CanonicalQid,
  registry: EthereumAddress,
  secret: CanonicalHex32,
  sessionId: CanonicalHex32,
  v: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected pairing offer field",
  parseOptions: strictParseOptions,
});
export { PairingOfferV1Schema as PairingOfferV1 };
export type PairingOfferV1 = typeof PairingOfferV1Schema.Type;
export type PairingOfferV1Encoded = typeof PairingOfferV1Schema.Encoded;

const PairingHelloV1Schema = Schema.Struct({
  challenge: CanonicalHex32,
  secret: CanonicalHex32,
  sessionId: CanonicalHex32,
  type: Schema.Literal("hello"),
  v: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected pairing hello field",
  parseOptions: strictParseOptions,
});

const PairingHelloAckV1Schema = Schema.Struct({
  chainId: CanonicalChainId,
  challenge: CanonicalHex32,
  deviceKey: CanonicalHex32,
  qid: CanonicalQid,
  registry: EthereumAddress,
  sessionId: CanonicalHex32,
  type: Schema.Literal("helloAck"),
  v: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected pairing hello-ack field",
  parseOptions: strictParseOptions,
});

const PairingApprovalV1Schema = Schema.Struct({
  record: DeviceActionApprovalV1,
  sessionId: CanonicalHex32,
  type: Schema.Literal("approval"),
  v: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected pairing approval field",
  parseOptions: strictParseOptions,
});

const PairingApprovalSavedV1Schema = Schema.Struct({
  digest: CanonicalHex32,
  sessionId: CanonicalHex32,
  type: Schema.Literal("approvalSaved"),
  v: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected pairing approval-saved field",
  parseOptions: strictParseOptions,
});

const PairingApprovalConflictV1Schema = Schema.Struct({
  digest: CanonicalHex32,
  sessionId: CanonicalHex32,
  type: Schema.Literal("approvalConflict"),
  v: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected pairing approval-conflict field",
  parseOptions: strictParseOptions,
});

export const PairingFrameV1Schema = Schema.Union([
  PairingHelloV1Schema,
  PairingHelloAckV1Schema,
  PairingApprovalV1Schema,
  PairingApprovalSavedV1Schema,
  PairingApprovalConflictV1Schema,
]);
export { PairingFrameV1Schema as PairingFrameV1 };
export type PairingFrameV1 = typeof PairingFrameV1Schema.Type;
export type PairingFrameV1Encoded = typeof PairingFrameV1Schema.Encoded;

export class PairingCodecError extends Data.TaggedError("PairingCodecError")<{
  readonly operation: "expired" | "frame" | "offer" | "oversized" | "version";
}> {}

const QR_PREFIX = "qop-pair1.";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const encodeJson = (value: PairingOfferV1Encoded | PairingFrameV1Encoded) =>
  Effect.sync(() => textEncoder.encode(JSON.stringify(value))).pipe(
    Effect.flatMap((encoded) =>
      encoded.byteLength > PAIRING_FRAME_MAX_BYTES
        ? Effect.fail(new PairingCodecError({ operation: "oversized" }))
        : Effect.succeed(encoded)
    )
  );

export const encodePairingOfferV1 = Effect.fn(
  "@qop/protocol/encodePairingOfferV1"
)(function* (offer: PairingOfferV1) {
  const encoded = yield* Schema.encodeEffect(PairingOfferV1Schema)(offer).pipe(
    Effect.mapError(() => new PairingCodecError({ operation: "offer" }))
  );
  const bytes = yield* encodeJson(encoded);
  const payload = `${QR_PREFIX}${base64urlnopad.encode(bytes)}`;
  if (payload.length > PAIRING_QR_MAX_CHARS) {
    return yield* new PairingCodecError({ operation: "oversized" });
  }
  return payload;
});

export const decodePairingOfferV1 = Effect.fn(
  "@qop/protocol/decodePairingOfferV1"
)(function* (input: string, nowSeconds: bigint) {
  if (input.length > PAIRING_QR_MAX_CHARS) {
    return yield* new PairingCodecError({ operation: "oversized" });
  }
  if (!input.startsWith(QR_PREFIX)) {
    return yield* new PairingCodecError({ operation: "version" });
  }
  const bytes = yield* Effect.try({
    catch: () => new PairingCodecError({ operation: "offer" }),
    try: () => base64urlnopad.decode(input.slice(QR_PREFIX.length)),
  });
  const json = yield* Effect.try({
    catch: () => new PairingCodecError({ operation: "offer" }),
    // SAFETY: JSON.parse is untyped; PairingOfferV1 is decoded immediately below.
    try: () => JSON.parse(textDecoder.decode(bytes)) as unknown,
  });
  const offer = yield* Schema.decodeUnknownEffect(PairingOfferV1Schema)(
    json
  ).pipe(Effect.mapError(() => new PairingCodecError({ operation: "offer" })));
  if (BigInt(offer.expiresAt) <= nowSeconds) {
    return yield* new PairingCodecError({ operation: "expired" });
  }
  return offer;
});

export const encodePairingFrameV1 = Effect.fn(
  "@qop/protocol/encodePairingFrameV1"
)((frame: PairingFrameV1) =>
  Schema.encodeEffect(PairingFrameV1Schema)(frame).pipe(
    Effect.mapError(() => new PairingCodecError({ operation: "frame" })),
    Effect.flatMap(encodeJson)
  )
);

export const decodePairingFrameV1 = Effect.fn(
  "@qop/protocol/decodePairingFrameV1"
)(function* (bytes: Uint8Array) {
  if (bytes.byteLength > PAIRING_FRAME_MAX_BYTES) {
    return yield* new PairingCodecError({ operation: "oversized" });
  }
  const json = yield* Effect.try({
    catch: () => new PairingCodecError({ operation: "frame" }),
    // SAFETY: JSON.parse is untyped; PairingFrameV1 is decoded immediately below.
    try: () => JSON.parse(textDecoder.decode(bytes)) as unknown,
  });
  return yield* Schema.decodeUnknownEffect(PairingFrameV1Schema)(json).pipe(
    Effect.mapError(() => new PairingCodecError({ operation: "frame" }))
  );
});

export const pairingFingerprint = (deviceKey: string) =>
  deviceKey.slice(2, 10).toUpperCase();
