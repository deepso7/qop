import {
  EcdsaSignature,
  EthereumAddress,
  RegisterIntentV1,
} from "@qop/identity";
import type { RegisterIntentV1 as RegisterIntent } from "@qop/identity";
import { Context, Data, Effect, Layer, Schema, Semaphore } from "effect";
import { createWalletClient, http, parseAbi, toHex } from "viem";
import type { Address, Hash, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { Env } from "../env.ts";

const registryWriteAbi = parseAbi([
  "function register((string handle,address owner,bytes32 deviceCommitment,bytes32 nonce,uint64 deadline) intent, bytes ownerSignature, bytes registrationSignature) returns (uint256 qid)",
]);

const PrivateKey = Schema.String.check(
  Schema.isPattern(/^0x[0-9a-f]{64}$/iu, {
    expected: "a 32-byte 0x-prefixed private key",
  })
);

export class RegistrationRelayerError extends Data.TaggedError(
  "RegistrationRelayerError"
)<{ readonly operation: "configure" | "submit" }> {}

export interface RegistrationRelayerShape {
  readonly submit: (
    intent: RegisterIntent,
    ownerSignature: Hex,
    registrationSignature: Hex
  ) => Effect.Effect<Hash, RegistrationRelayerError>;
}

export class RegistrationRelayer extends Context.Service<
  RegistrationRelayer,
  RegistrationRelayerShape
>()("@qop/api/RegistrationRelayer") {}

export const makeRegistrationRelayer = Effect.fn("RegistrationRelayer.make")(
  function* (input: unknown) {
    const env = yield* Env;
    const privateKey = yield* Schema.decodeUnknownEffect(PrivateKey)(
      input
    ).pipe(
      Effect.mapError(
        () => new RegistrationRelayerError({ operation: "configure" })
      )
    );
    const account = yield* Effect.try({
      catch: () => new RegistrationRelayerError({ operation: "configure" }),
      try: () => privateKeyToAccount(privateKey as Hex),
    });
    const client = createWalletClient({
      account,
      transport: http(env.RPC_URL.toString()),
    });
    const semaphore = yield* Semaphore.make(1);

    const submit = Effect.fn("RegistrationRelayer.submit")(function* (
      intent: RegisterIntent,
      ownerSignature: Hex,
      registrationSignature: Hex
    ) {
      yield* Schema.encodeEffect(RegisterIntentV1)(intent).pipe(
        Effect.andThen(
          Schema.decodeUnknownEffect(EthereumAddress)(intent.owner)
        ),
        Effect.andThen(
          Schema.decodeUnknownEffect(EcdsaSignature)(ownerSignature)
        ),
        Effect.andThen(
          Schema.decodeUnknownEffect(EcdsaSignature)(registrationSignature)
        ),
        Effect.mapError(
          () => new RegistrationRelayerError({ operation: "submit" })
        )
      );
      return yield* semaphore.withPermits(1)(
        Effect.tryPromise({
          catch: () => new RegistrationRelayerError({ operation: "submit" }),
          try: () =>
            client.writeContract({
              abi: registryWriteAbi,
              address: env.REGISTRY_ADDRESS as Address,
              args: [
                {
                  deadline: intent.deadline,
                  deviceCommitment: toHex(intent.deviceCommitment),
                  handle: intent.handle,
                  nonce: toHex(intent.nonce),
                  owner: intent.owner as Address,
                },
                ownerSignature,
                registrationSignature,
              ],
              chain: undefined,
              functionName: "register",
            }),
        })
      );
    });

    return RegistrationRelayer.of({ submit });
  }
);

export const registrationRelayerLayer = (privateKey: unknown) =>
  Layer.effect(RegistrationRelayer, makeRegistrationRelayer(privateKey));
