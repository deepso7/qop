import { x25519 } from "@noble/curves/ed25519.js";
import { Data, Effect } from "effect";

export class DeviceEncryptionCryptoError extends Data.TaggedError(
  "DeviceEncryptionCryptoError"
)<{
  readonly cause?: unknown;
  readonly operation: "derive-public-key";
}> {}

export const encryptionPublicKeyFromSecretKey = Effect.fn(
  "@qop/identity/encryptionPublicKeyFromSecretKey"
)(function* (secretKey: Uint8Array) {
  if (secretKey.length !== 32) {
    return yield* new DeviceEncryptionCryptoError({
      operation: "derive-public-key",
    });
  }
  return yield* Effect.try({
    catch: (cause) =>
      new DeviceEncryptionCryptoError({
        cause,
        operation: "derive-public-key",
      }),
    try: () => x25519.getPublicKey(secretKey),
  });
});
