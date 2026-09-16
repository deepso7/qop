import { Hex32 } from "@qop/identity";
import type {
  AddDeviceIntentV1Encoded,
  RemoveDeviceIntentV1Encoded,
} from "@qop/identity";
import { Data, Effect, Schema } from "effect";

const CanonicalHex32 = Hex32.pipe(Schema.decodeTo(Hex32.pipe(Schema.flip)));

const SubmittedResponse = Schema.Struct({
  digest: CanonicalHex32,
  status: Schema.Literals(["submitted", "confirmed"]),
  transactionHash: CanonicalHex32,
});

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

const ErrorResponse = Schema.Struct({
  _tag: Schema.String,
  digest: Schema.optionalKey(CanonicalHex32),
  kind: Schema.optionalKey(Schema.String),
});

export type SubmittedDeviceAction = typeof SubmittedResponse.Type;
export type ReconciledDeviceAction = typeof ReconciledResponse.Type;

export interface DeviceActionSubmitInput {
  readonly intent: AddDeviceIntentV1Encoded | RemoveDeviceIntentV1Encoded;
  readonly operation: "add" | "remove";
  readonly ownerSignature: string;
}

export class DeviceActionClientError extends Data.TaggedError(
  "DeviceActionClientError"
)<{
  readonly kind: string | null;
  readonly status: number | null;
}> {}

const configuredApiUrl = () => {
  const configured = process.env.EXPO_PUBLIC_API_URL;
  if (!configured) {
    return null;
  }
  return configured.replace(/\/$/u, "");
};

export const createDeviceActionClient = ({
  fetch: fetchImpl,
}: {
  readonly fetch: (input: URL, init?: RequestInit) => Promise<Response>;
}) => {
  const request = Effect.fn("DeviceActionClient.request")(function* (
    path: string,
    init?: RequestInit
  ) {
    const root = configuredApiUrl();
    if (!root) {
      return yield* new DeviceActionClientError({
        kind: "configuration",
        status: null,
      });
    }
    const response = yield* Effect.tryPromise({
      catch: () =>
        new DeviceActionClientError({ kind: "network", status: null }),
      try: () => fetchImpl(new URL(path, `${root}/`), init),
    });
    const body = yield* Effect.tryPromise({
      catch: () =>
        new DeviceActionClientError({
          kind: "decode",
          status: response.status,
        }),
      // SAFETY: The response JSON is decoded immediately below.
      try: () => response.json() as Promise<unknown>,
    });
    if (!response.ok) {
      const parsed = Schema.decodeUnknownOption(ErrorResponse)(body);
      return yield* new DeviceActionClientError({
        kind:
          parsed._tag === "Some"
            ? (parsed.value.kind ?? parsed.value._tag)
            : null,
        status: response.status,
      });
    }
    return body;
  });

  const submit = Effect.fn("DeviceActionClient.submit")(
    (input: DeviceActionSubmitInput) =>
      request("v1/device-actions/", {
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
        method: "POST",
      }).pipe(
        Effect.flatMap((body) =>
          Schema.decodeUnknownEffect(SubmittedResponse)(body).pipe(
            Effect.mapError(
              () => new DeviceActionClientError({ kind: "decode", status: 200 })
            )
          )
        )
      )
  );

  const get = Effect.fn("DeviceActionClient.get")((digest: string) =>
    request(`v1/device-actions/${digest}`).pipe(
      Effect.flatMap((body) =>
        Schema.decodeUnknownEffect(ReconciledResponse)(body).pipe(
          Effect.mapError(
            () => new DeviceActionClientError({ kind: "decode", status: 200 })
          )
        )
      )
    )
  );

  return { get, submit };
};
