import { randomBytes } from "node:crypto";

import { Context, Data, Effect, Layer } from "effect";

export class EntropyError extends Data.TaggedError("EntropyError")<{
  readonly cause: unknown;
}> {}

export interface EntropyShape {
  readonly bytes32: Effect.Effect<Uint8Array, EntropyError>;
}

export class Entropy extends Context.Service<Entropy, EntropyShape>()(
  "@qop/api/Entropy"
) {
  static readonly layer = Layer.succeed(
    this,
    this.of({
      bytes32: Effect.try({
        catch: (cause) => new EntropyError({ cause }),
        try: () => Uint8Array.from(randomBytes(32)),
      }),
    })
  );
}
