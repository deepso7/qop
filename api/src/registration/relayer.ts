import {
  EcdsaSignature,
  EthereumAddress,
  RegisterIntentV1,
} from "@qop/identity";
import type { RegisterIntentV1 as RegisterIntent } from "@qop/identity";
import { Context, Data, Effect, Layer, Schema } from "effect";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  toHex,
} from "viem";
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
)<{ readonly operation: "broadcast" | "configure" | "prepare" }> {}

export interface PreparedRegistrationRelay {
  readonly serializedTransaction: Hex;
  readonly transactionHash: Hash;
}

export interface RegistrationRelayerShape {
  readonly broadcast: (
    prepared: PreparedRegistrationRelay
  ) => Effect.Effect<Hash, RegistrationRelayerError>;
  readonly prepare: (
    intent: RegisterIntent,
    ownerSignature: Hex,
    registrationSignature: Hex,
    nonce: bigint
  ) => Effect.Effect<PreparedRegistrationRelay, RegistrationRelayerError>;
  readonly pendingNonce: Effect.Effect<bigint, RegistrationRelayerError>;
}

export class RegistrationRelayer extends Context.Service<
  RegistrationRelayer,
  RegistrationRelayerShape
>()("@qop/api/RegistrationRelayer") {}

export const makeRegistrationRelayer = Effect.fn("RegistrationRelayer.make")(
  function* (input: unknown) {
    const env = yield* Env;
    if (env.CHAIN_ID > BigInt(Number.MAX_SAFE_INTEGER)) {
      return yield* new RegistrationRelayerError({ operation: "configure" });
    }
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
    const chain = {
      id: Number(env.CHAIN_ID),
      name: "QOP Registry",
      nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
      rpcUrls: { default: { http: [env.RPC_URL.toString()] } },
    } as const;
    const client = createWalletClient({
      account,
      chain,
      transport: http(env.RPC_URL.toString()),
    });
    const publicClient = createPublicClient({
      chain,
      transport: http(env.RPC_URL.toString()),
    });
    const prepare = Effect.fn("RegistrationRelayer.prepare")(function* (
      intent: RegisterIntent,
      ownerSignature: Hex,
      registrationSignature: Hex,
      nonce: bigint
    ) {
      if (nonce < 0n || nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
        return yield* new RegistrationRelayerError({ operation: "prepare" });
      }
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
          () => new RegistrationRelayerError({ operation: "prepare" })
        )
      );
      return yield* Effect.tryPromise({
        catch: () => new RegistrationRelayerError({ operation: "prepare" }),
        try: async () => {
          const data = encodeFunctionData({
            abi: registryWriteAbi,
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
            functionName: "register",
          });
          const request = await client.prepareTransactionRequest({
            account,
            data,
            nonce: Number(nonce),
            to: env.REGISTRY_ADDRESS as Address,
          });
          const serializedTransaction = await client.signTransaction(request);
          return {
            serializedTransaction,
            transactionHash: keccak256(serializedTransaction),
          } satisfies PreparedRegistrationRelay;
        },
      });
    });

    const transactionExists = (transactionHash: Hash) =>
      Effect.tryPromise({
        catch: (cause) => cause,
        try: () => publicClient.getTransaction({ hash: transactionHash }),
      }).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));

    const pendingNonce = Effect.tryPromise({
      catch: () => new RegistrationRelayerError({ operation: "prepare" }),
      try: async () =>
        BigInt(
          await publicClient.getTransactionCount({
            address: account.address,
            blockTag: "pending",
          })
        ),
    });

    const broadcast = Effect.fn("RegistrationRelayer.broadcast")(function* (
      prepared: PreparedRegistrationRelay
    ) {
      if (
        keccak256(prepared.serializedTransaction) !== prepared.transactionHash
      ) {
        return yield* new RegistrationRelayerError({ operation: "broadcast" });
      }
      if (yield* transactionExists(prepared.transactionHash)) {
        return prepared.transactionHash;
      }
      return yield* Effect.tryPromise({
        catch: () => new RegistrationRelayerError({ operation: "broadcast" }),
        try: () =>
          client.sendRawTransaction({
            serializedTransaction: prepared.serializedTransaction,
          }),
      }).pipe(
        Effect.catch((error) =>
          transactionExists(prepared.transactionHash).pipe(
            Effect.flatMap((exists) =>
              exists
                ? Effect.succeed(prepared.transactionHash)
                : Effect.fail(error)
            )
          )
        )
      );
    });

    return RegistrationRelayer.of({ broadcast, pendingNonce, prepare });
  }
);

export const registrationRelayerLayer = (privateKey: unknown) =>
  Layer.effect(RegistrationRelayer, makeRegistrationRelayer(privateKey));
