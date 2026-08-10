import {
  EcdsaSignature,
  makeRegisterIntentTypedDataV1,
  normalizeEcdsaSignature,
} from "@qop/identity";
import type { IdentityEip712DomainV1, RegisterIntentV1 } from "@qop/identity";
import { Context, Data, Effect, Layer, Schema } from "effect";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const PrivateKey = Schema.String.check(
  Schema.isPattern(/^0x[0-9a-f]{64}$/iu, {
    expected: "a 32-byte 0x-prefixed private key",
  })
);

export class RegistrationSignerError extends Data.TaggedError(
  "RegistrationSignerError"
)<{ readonly operation: "configure" | "sign" }> {}

export interface RegistrationSignerShape {
  readonly address: Address;
  readonly sign: (
    domain: IdentityEip712DomainV1,
    intent: RegisterIntentV1
  ) => Effect.Effect<Hex, RegistrationSignerError>;
}

export class RegistrationSigner extends Context.Service<
  RegistrationSigner,
  RegistrationSignerShape
>()("@qop/api/RegistrationSigner") {}

export const makeRegistrationSigner = Effect.fn("RegistrationSigner.make")(
  function* (input: unknown) {
    const privateKey = yield* Schema.decodeUnknownEffect(PrivateKey)(
      input
    ).pipe(
      Effect.mapError(
        () => new RegistrationSignerError({ operation: "configure" })
      )
    );
    const account = yield* Effect.try({
      catch: () => new RegistrationSignerError({ operation: "configure" }),
      try: () => privateKeyToAccount(privateKey as Hex),
    });

    const sign = Effect.fn("RegistrationSigner.sign")(function* (
      domain: IdentityEip712DomainV1,
      intent: RegisterIntentV1
    ) {
      const walletSignature = yield* Effect.tryPromise({
        catch: () => new RegistrationSignerError({ operation: "sign" }),
        try: () =>
          account.signTypedData(makeRegisterIntentTypedDataV1(domain, intent)),
      });
      const bytes = yield* normalizeEcdsaSignature(walletSignature).pipe(
        Effect.mapError(
          () => new RegistrationSignerError({ operation: "sign" })
        )
      );
      return (yield* Schema.encodeEffect(EcdsaSignature)(bytes).pipe(
        Effect.mapError(
          () => new RegistrationSignerError({ operation: "sign" })
        )
      )) as Hex;
    });

    return RegistrationSigner.of({
      address: account.address.toLowerCase() as Address,
      sign,
    });
  }
);

export const registrationSignerLayer = (privateKey: unknown) =>
  Layer.effect(RegistrationSigner, makeRegistrationSigner(privateKey));
