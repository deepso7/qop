import {
  decodeIdentityEnvelopeV1,
  encodeIdentityEnvelopeV1,
} from "@qop/identity";
import type { IdentityEnvelopeV1Encoded } from "@qop/identity";
import { Data, Effect } from "effect";
import { toHex } from "viem";
import type { Hex } from "viem";

export class DeviceCertificateInputError extends Data.TaggedError(
  "DeviceCertificateInputError"
)<{
  readonly cause: unknown;
  readonly field: "envelope";
}> {}

export interface NormalizedIdentityEnvelope {
  readonly certificate: IdentityEnvelopeV1Encoded["certificate"];
  readonly signature: Hex;
  readonly version: IdentityEnvelopeV1Encoded["version"];
}

export const normalizeIdentityEnvelope = Effect.fn(
  "DeviceCertificateInput.normalizeEnvelope"
)(function* (
  input: IdentityEnvelopeV1Encoded
): Effect.fn.Return<NormalizedIdentityEnvelope, DeviceCertificateInputError> {
  const envelope = yield* decodeIdentityEnvelopeV1(input).pipe(
    Effect.mapError(
      (cause) => new DeviceCertificateInputError({ cause, field: "envelope" })
    )
  );
  const encoded = yield* encodeIdentityEnvelopeV1(envelope).pipe(
    Effect.mapError(
      (cause) => new DeviceCertificateInputError({ cause, field: "envelope" })
    )
  );
  return { ...encoded, signature: toHex(envelope.signature) };
});
