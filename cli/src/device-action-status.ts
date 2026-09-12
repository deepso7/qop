import { Hex32 } from "@qop/identity";
import { Data, Effect, Schema } from "effect";

const CanonicalHex32 = Hex32.pipe(Schema.decodeTo(Hex32.pipe(Schema.flip)));

const ReconciledResponse = Schema.Struct({
  digest: CanonicalHex32,
  failureCode: Schema.NullOr(Schema.String),
  status: Schema.Literals([
    "ready",
    "submitted",
    "confirmed",
    "reverted",
    "expired",
  ]),
  transactionHash: Schema.NullOr(CanonicalHex32),
});

export class DeviceActionStatusError extends Data.TaggedError(
  "DeviceActionStatusError"
)<{
  readonly operation: "decode" | "missing" | "network";
}> {}

export const getDeviceActionStatus = Effect.fn("cli.getDeviceActionStatus")(
  function* (apiUrl: string, digest: string) {
    const response = yield* Effect.tryPromise({
      catch: () => new DeviceActionStatusError({ operation: "network" }),
      try: () => fetch(`${apiUrl}/v1/device-actions/${digest}`),
    });
    if (response.status === 404) {
      return yield* new DeviceActionStatusError({ operation: "missing" });
    }
    const body = yield* Effect.tryPromise({
      catch: () => new DeviceActionStatusError({ operation: "decode" }),
      // SAFETY: JSON is decoded with ReconciledResponse immediately below.
      try: () => response.json() as Promise<unknown>,
    });
    if (!response.ok) {
      return yield* new DeviceActionStatusError({ operation: "network" });
    }
    return yield* Schema.decodeUnknownEffect(ReconciledResponse)(body).pipe(
      Effect.mapError(
        () => new DeviceActionStatusError({ operation: "decode" })
      )
    );
  }
);
