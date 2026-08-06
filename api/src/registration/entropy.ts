import { randomBytes } from "node:crypto";

import { Context, Data, Effect, Layer } from "effect";

export class RegistrationEntropyError extends Data.TaggedError(
  "RegistrationEntropyError"
)<{ readonly cause: unknown }> {}

export interface RegistrationEntropyShape {
  readonly bytes32: Effect.Effect<Uint8Array, RegistrationEntropyError>;
}

export class RegistrationEntropy extends Context.Service<
  RegistrationEntropy,
  RegistrationEntropyShape
>()("@qop/api/RegistrationEntropy") {
  static readonly layer = Layer.succeed(
    this,
    this.of({
      bytes32: Effect.try({
        catch: (cause) => new RegistrationEntropyError({ cause }),
        try: () => Uint8Array.from(randomBytes(32)),
      }),
    })
  );
}
