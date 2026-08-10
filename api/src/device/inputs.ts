import {
  decodeIdentityEnvelopeV1,
  encodeIdentityEnvelopeV1,
} from "@qop/identity";
import type { IdentityEnvelopeV1Encoded } from "@qop/identity";
import { Data, Effect } from "effect";

export class DeviceCertificateInputError extends Data.TaggedError(
  "DeviceCertificateInputError"
)<{
  readonly cause: unknown;
  readonly field: "envelope";
}> {}

export const normalizeIdentityEnvelope = Effect.fn(
  "DeviceCertificateInput.normalizeEnvelope"
)(function* (
  input: unknown
): Effect.fn.Return<IdentityEnvelopeV1Encoded, DeviceCertificateInputError> {
  const envelope = yield* decodeIdentityEnvelopeV1(input).pipe(
    Effect.mapError(
      (cause) => new DeviceCertificateInputError({ cause, field: "envelope" })
    )
  );
  return yield* encodeIdentityEnvelopeV1(envelope).pipe(
    Effect.mapError(
      (cause) => new DeviceCertificateInputError({ cause, field: "envelope" })
    )
  );
});
