import { Effect, Schema } from "effect";

import { strictParseOptions } from "./internal.ts";
import { identityProtocolVersion } from "./version.ts";
import {
  Base64Url32,
  EcdsaSignature,
  PeerId,
  Qid,
  UnixSeconds,
} from "./wire-codecs.ts";

const UINT32_MAX = 4_294_967_295;
export const OwnerVersion = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ maximum: UINT32_MAX, minimum: 0 })
);

export const DeviceCertificateV1 = Schema.Struct({
  encryptionPublicKey: Base64Url32,
  expiresAt: UnixSeconds,
  issuedAt: UnixSeconds,
  ownerVersion: OwnerVersion,
  peerId: PeerId,
  qid: Qid,
  salt: Base64Url32,
  version: Schema.Literal(identityProtocolVersion),
})
  .annotate({
    messageUnexpectedKey: "Unexpected device certificate field",
    parseOptions: strictParseOptions,
  })
  .check(
    Schema.makeFilter(
      (certificate) => certificate.expiresAt > certificate.issuedAt,
      { expected: "expiresAt later than issuedAt" }
    )
  )
  .annotate({ parseOptions: strictParseOptions });

export type DeviceCertificateV1 = typeof DeviceCertificateV1.Type;
export type DeviceCertificateV1Encoded = typeof DeviceCertificateV1.Encoded;

export const IdentityEnvelopeV1 = Schema.Struct({
  certificate: DeviceCertificateV1,
  signature: EcdsaSignature,
  version: Schema.Literal(identityProtocolVersion),
}).annotate({
  messageUnexpectedKey: "Unexpected identity envelope field",
  parseOptions: strictParseOptions,
});

export type IdentityEnvelopeV1 = typeof IdentityEnvelopeV1.Type;
export type IdentityEnvelopeV1Encoded = typeof IdentityEnvelopeV1.Encoded;

export const decodeDeviceCertificateV1 = Effect.fn(
  "@qop/identity/decodeDeviceCertificateV1"
)((input: unknown) => Schema.decodeUnknownEffect(DeviceCertificateV1)(input));

export const encodeDeviceCertificateV1 = Effect.fn(
  "@qop/identity/encodeDeviceCertificateV1"
)((certificate: DeviceCertificateV1) =>
  Schema.encodeEffect(DeviceCertificateV1)(certificate)
);

export const decodeIdentityEnvelopeV1 = Effect.fn(
  "@qop/identity/decodeIdentityEnvelopeV1"
)((input: unknown) => Schema.decodeUnknownEffect(IdentityEnvelopeV1)(input));

export const encodeIdentityEnvelopeV1 = Effect.fn(
  "@qop/identity/encodeIdentityEnvelopeV1"
)((envelope: IdentityEnvelopeV1) =>
  Schema.encodeEffect(IdentityEnvelopeV1)(envelope)
);
