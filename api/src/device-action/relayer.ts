import {
  AddDeviceIntentV1,
  EcdsaSignature,
  RemoveDeviceIntentV1,
} from "@qop/identity";
import type {
  AddDeviceIntentV1 as AddDeviceIntent,
  RemoveDeviceIntentV1 as RemoveDeviceIntent,
} from "@qop/identity";
import { Context, Data, Effect, Layer, Schema } from "effect";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  isAddress,
  isHex,
  keccak256,
  parseAbi,
  toHex,
} from "viem";
import type { Hash, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { Env } from "../env.ts";
import type { DeviceActionOperation } from "./types.ts";

const registryWriteAbi = parseAbi([
  "function addDevice((uint256 qid, bytes32 deviceKey, uint256 nonce, uint64 deadline) intent, bytes ownerSignature)",
  "function removeDevice((uint256 qid, bytes32 deviceKey, uint256 nonce, uint64 deadline) intent, bytes ownerSignature)",
]);

const PrivateKey = Schema.String.check(
  Schema.isPattern(/^0x[0-9a-f]{64}$/iu, {
    expected: "a 32-byte 0x-prefixed private key",
  })
);

export class DeviceActionRelayerError extends Data.TaggedError(
  "DeviceActionRelayerError"
)<{ readonly operation: "broadcast" | "configure" | "prepare" }> {}

export interface PreparedDeviceActionRelay {
  readonly serializedTransaction: Hex;
  readonly transactionHash: Hash;
}

export type DeviceActionIntent = AddDeviceIntent | RemoveDeviceIntent;

export interface DeviceActionRelayerContract {
  readonly broadcast: (
    prepared: PreparedDeviceActionRelay
  ) => Effect.Effect<Hash, DeviceActionRelayerError>;
  readonly pendingNonce: Effect.Effect<bigint, DeviceActionRelayerError>;
  readonly prepare: (
    operation: DeviceActionOperation,
    intent: DeviceActionIntent,
    ownerSignature: Hex,
    nonce: bigint
  ) => Effect.Effect<PreparedDeviceActionRelay, DeviceActionRelayerError>;
}

export class DeviceActionRelayer extends Context.Service<
  DeviceActionRelayer,
  DeviceActionRelayerContract
>()("@qop/api/DeviceActionRelayer") {}

const encodeIntent = (intent: DeviceActionIntent) => ({
  deadline: intent.deadline,
  deviceKey: toHex(intent.deviceKey),
  nonce: intent.nonce,
  qid: intent.qid,
});

export const makeDeviceActionRelayer = Effect.fn("DeviceActionRelayer.make")(
  function* (input: string) {
    const env = yield* Env;
    if (env.CHAIN_ID > BigInt(Number.MAX_SAFE_INTEGER)) {
      return yield* new DeviceActionRelayerError({ operation: "configure" });
    }
    if (!isAddress(env.REGISTRY_ADDRESS)) {
      return yield* new DeviceActionRelayerError({ operation: "configure" });
    }
    const registryAddress = env.REGISTRY_ADDRESS;
    const privateKey = yield* Schema.decodeUnknownEffect(PrivateKey)(
      input
    ).pipe(
      Effect.mapError(
        () => new DeviceActionRelayerError({ operation: "configure" })
      )
    );
    if (!isHex(privateKey)) {
      return yield* new DeviceActionRelayerError({ operation: "configure" });
    }
    const account = yield* Effect.try({
      catch: () => new DeviceActionRelayerError({ operation: "configure" }),
      try: () => privateKeyToAccount(privateKey),
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

    const prepare = Effect.fn("DeviceActionRelayer.prepare")(function* (
      operation: DeviceActionOperation,
      intent: DeviceActionIntent,
      ownerSignature: Hex,
      nonce: bigint
    ) {
      if (nonce < 0n || nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
        return yield* new DeviceActionRelayerError({ operation: "prepare" });
      }
      const schema =
        operation === "add" ? AddDeviceIntentV1 : RemoveDeviceIntentV1;
      yield* Schema.encodeEffect(schema)(intent).pipe(
        Effect.andThen(
          Schema.decodeUnknownEffect(EcdsaSignature)(ownerSignature)
        ),
        Effect.mapError(
          () => new DeviceActionRelayerError({ operation: "prepare" })
        )
      );
      return yield* Effect.tryPromise({
        catch: () => new DeviceActionRelayerError({ operation: "prepare" }),
        try: async () => {
          const data = encodeFunctionData({
            abi: registryWriteAbi,
            args: [encodeIntent(intent), ownerSignature],
            functionName: operation === "add" ? "addDevice" : "removeDevice",
          });
          const request = await client.prepareTransactionRequest({
            account,
            data,
            nonce: Number(nonce),
            to: registryAddress,
          });
          const serializedTransaction = await client.signTransaction(request);
          return {
            serializedTransaction,
            transactionHash: keccak256(serializedTransaction),
          } satisfies PreparedDeviceActionRelay;
        },
      });
    });

    const transactionExists = (transactionHash: Hash) =>
      Effect.tryPromise({
        catch: (cause) => cause,
        try: () => publicClient.getTransaction({ hash: transactionHash }),
      }).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));

    const pendingNonce = Effect.tryPromise({
      catch: () => new DeviceActionRelayerError({ operation: "prepare" }),
      try: async () =>
        BigInt(
          await publicClient.getTransactionCount({
            address: account.address,
            blockTag: "pending",
          })
        ),
    });

    const broadcast = Effect.fn("DeviceActionRelayer.broadcast")(function* (
      prepared: PreparedDeviceActionRelay
    ) {
      if (
        keccak256(prepared.serializedTransaction) !== prepared.transactionHash
      ) {
        return yield* new DeviceActionRelayerError({ operation: "broadcast" });
      }
      if (yield* transactionExists(prepared.transactionHash)) {
        return prepared.transactionHash;
      }
      return yield* Effect.tryPromise({
        catch: () => new DeviceActionRelayerError({ operation: "broadcast" }),
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

    return DeviceActionRelayer.of({ broadcast, pendingNonce, prepare });
  }
);

export const deviceActionRelayerLayer = (privateKey: string) =>
  Layer.effect(DeviceActionRelayer, makeDeviceActionRelayer(privateKey));
