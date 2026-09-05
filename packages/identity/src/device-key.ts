import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { Data, Effect, Schema } from "effect";

import { Hex32, PeerId } from "./wire-codecs.ts";

const ED25519_PEER_ID_PREFIX = Uint8Array.from([0, 36, 8, 1, 18, 32]);

export class DeviceKeyError extends Data.TaggedError("DeviceKeyError")<{
  readonly cause?: unknown;
  readonly operation: "decode" | "derive-peer-id" | "derive-public-key";
}> {}

export const deviceKeyFromEd25519SecretKey = Effect.fn(
  "@qop/identity/deviceKeyFromEd25519SecretKey"
)(function* (secretKey: Uint8Array) {
  if (secretKey.length !== 32) {
    return yield* new DeviceKeyError({ operation: "derive-public-key" });
  }
  return yield* Effect.try({
    catch: (cause) =>
      new DeviceKeyError({ cause, operation: "derive-public-key" }),
    try: () => ed25519.getPublicKey(secretKey),
  });
});

export const peerIdFromDeviceKey = Effect.fn(
  "@qop/identity/peerIdFromDeviceKey"
)((deviceKey: Uint8Array) =>
  Schema.encodeEffect(Hex32)(deviceKey).pipe(
    Effect.map(() =>
      base58.encode(Uint8Array.from([...ED25519_PEER_ID_PREFIX, ...deviceKey]))
    ),
    Effect.flatMap(Schema.decodeUnknownEffect(PeerId)),
    Effect.mapError(
      (cause) => new DeviceKeyError({ cause, operation: "derive-peer-id" })
    )
  )
);

export const deviceKeyFromPeerId = Effect.fn(
  "@qop/identity/deviceKeyFromPeerId"
)((peerId: typeof PeerId.Type) =>
  Schema.encodeEffect(PeerId)(peerId).pipe(
    Effect.map(() => peerId.subarray(ED25519_PEER_ID_PREFIX.length)),
    Effect.flatMap((deviceKey) =>
      Schema.encodeEffect(Hex32)(deviceKey).pipe(Effect.as(deviceKey))
    ),
    Effect.mapError(
      (cause) => new DeviceKeyError({ cause, operation: "decode" })
    )
  )
);

export const peerIdFromEd25519SecretKey = Effect.fn(
  "@qop/identity/peerIdFromEd25519SecretKey"
)((secretKey: Uint8Array) =>
  deviceKeyFromEd25519SecretKey(secretKey).pipe(
    Effect.flatMap(peerIdFromDeviceKey),
    Effect.mapError(
      (cause) => new DeviceKeyError({ cause, operation: "derive-peer-id" })
    )
  )
);
