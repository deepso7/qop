import { randomBytes } from "node:crypto";

import { Context, Data, Effect, Layer } from "effect";

export class DeviceSessionEntropyError extends Data.TaggedError(
  "DeviceSessionEntropyError"
)<{ readonly cause: unknown }> {}

export interface DeviceSessionEntropyShape {
  readonly bytes32: Effect.Effect<Uint8Array, DeviceSessionEntropyError>;
}

export class DeviceSessionEntropy extends Context.Service<
  DeviceSessionEntropy,
  DeviceSessionEntropyShape
>()("@qop/api/DeviceSessionEntropy") {
  static readonly layer = Layer.succeed(
    this,
    this.of({
      bytes32: Effect.try({
        catch: (cause) => new DeviceSessionEntropyError({ cause }),
        try: () => Uint8Array.from(randomBytes(32)),
      }),
    })
  );
}
