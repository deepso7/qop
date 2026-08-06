import { Context, Data, Effect, Layer } from "effect";
import { createPublicClient, http, keccak256, stringToBytes } from "viem";
import type { Address, Hash } from "viem";

import { Env } from "../env.ts";
import { registryReadAbi } from "./abi.ts";
import {
  normalizeCertificateDigest,
  normalizeRegistryHandle,
  normalizeRegistryOwner,
} from "./inputs.ts";
import type { RegistryInputError } from "./inputs.ts";
import type { RegistryAccount, RegistrySnapshot } from "./types.ts";

type RegistryChainOperation =
  | "account"
  | "chain-id"
  | "confirmed-block"
  | "device-revocation"
  | "qid-by-handle"
  | "qid-by-owner";

export class RegistryChainError extends Data.TaggedError("RegistryChainError")<{
  readonly cause: unknown;
  readonly operation: RegistryChainOperation;
}> {}

export type RegistryChainReadError = RegistryChainError | RegistryInputError;

export interface RegistryChainShape {
  readonly account: (
    qid: bigint
  ) => Effect.Effect<RegistrySnapshot<RegistryAccount>, RegistryChainError>;
  readonly deviceRevocation: (
    qid: bigint,
    certificateDigest: Hash
  ) => Effect.Effect<RegistrySnapshot<boolean>, RegistryChainReadError>;
  readonly qidByHandle: (
    handle: string
  ) => Effect.Effect<RegistrySnapshot<bigint | null>, RegistryChainReadError>;
  readonly qidByOwner: (
    owner: Address
  ) => Effect.Effect<RegistrySnapshot<bigint | null>, RegistryChainReadError>;
}

export class RegistryChain extends Context.Service<
  RegistryChain,
  RegistryChainShape
>()("@qop/api/RegistryChain") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const env = yield* Env;
      const client = createPublicClient({
        transport: http(env.RPC_URL.toString(), { batch: true }),
      });
      const registryAddress = env.REGISTRY_ADDRESS as Address;
      const rpcChainId = yield* Effect.tryPromise({
        catch: (cause) =>
          new RegistryChainError({ cause, operation: "chain-id" }),
        try: () => client.getChainId(),
      });
      if (BigInt(rpcChainId) !== env.CHAIN_ID) {
        return yield* new RegistryChainError({
          cause: `RPC chain ${rpcChainId} does not match configured chain ${env.CHAIN_ID}`,
          operation: "chain-id",
        });
      }

      const confirmedBlock = yield* Effect.cachedWithTTL(
        Effect.fn("RegistryChain.confirmedBlock")(function* () {
          const latest = yield* Effect.tryPromise({
            catch: (cause) =>
              new RegistryChainError({
                cause,
                operation: "confirmed-block",
              }),
            try: () => client.getBlockNumber(),
          });
          const confirmations = BigInt(env.REGISTRY_CONFIRMATIONS);
          return latest >= confirmations ? latest - confirmations : 0n;
        })(),
        "1 second"
      );

      const account = Effect.fn("RegistryChain.account")(function* (
        qid: bigint
      ) {
        const blockNumber = yield* confirmedBlock;
        const [owner, ownerVersion, registeredAt, nonce, handle] =
          yield* Effect.tryPromise({
            catch: (cause) =>
              new RegistryChainError({ cause, operation: "account" }),
            try: () =>
              client.readContract({
                abi: registryReadAbi,
                address: registryAddress,
                args: [qid],
                blockNumber,
                functionName: "account",
              }),
          });

        return {
          blockNumber,
          value: {
            handle,
            nonce,
            owner: owner.toLowerCase() as Address,
            ownerVersion,
            qid,
            registeredAt,
          },
        } satisfies RegistrySnapshot<RegistryAccount>;
      });

      const deviceRevocation = Effect.fn("RegistryChain.deviceRevocation")(
        function* (qid: bigint, certificateDigest: Hash) {
          const canonicalDigest =
            yield* normalizeCertificateDigest(certificateDigest);
          const blockNumber = yield* confirmedBlock;
          const value = yield* Effect.tryPromise({
            catch: (cause) =>
              new RegistryChainError({
                cause,
                operation: "device-revocation",
              }),
            try: () =>
              client.readContract({
                abi: registryReadAbi,
                address: registryAddress,
                args: [qid, canonicalDigest],
                blockNumber,
                functionName: "isDeviceRevoked",
              }),
          });
          return { blockNumber, value } satisfies RegistrySnapshot<boolean>;
        }
      );

      const qidByHandle = Effect.fn("RegistryChain.qidByHandle")(function* (
        handle: string
      ) {
        const canonicalHandle = yield* normalizeRegistryHandle(handle);
        const blockNumber = yield* confirmedBlock;
        const handleHash = keccak256(stringToBytes(canonicalHandle));
        const qid = yield* Effect.tryPromise({
          catch: (cause) =>
            new RegistryChainError({ cause, operation: "qid-by-handle" }),
          try: () =>
            client.readContract({
              abi: registryReadAbi,
              address: registryAddress,
              args: [handleHash],
              blockNumber,
              functionName: "qidByHandleHash",
            }),
        });
        return {
          blockNumber,
          value: qid === 0n ? null : qid,
        } satisfies RegistrySnapshot<bigint | null>;
      });

      const qidByOwner = Effect.fn("RegistryChain.qidByOwner")(function* (
        owner: Address
      ) {
        const canonicalOwner = yield* normalizeRegistryOwner(owner);
        const blockNumber = yield* confirmedBlock;
        const qid = yield* Effect.tryPromise({
          catch: (cause) =>
            new RegistryChainError({ cause, operation: "qid-by-owner" }),
          try: () =>
            client.readContract({
              abi: registryReadAbi,
              address: registryAddress,
              args: [canonicalOwner],
              blockNumber,
              functionName: "qidByOwner",
            }),
        });
        return {
          blockNumber,
          value: qid === 0n ? null : qid,
        } satisfies RegistrySnapshot<bigint | null>;
      });

      return RegistryChain.of({
        account,
        deviceRevocation,
        qidByHandle,
        qidByOwner,
      });
    })
  );
}

export const RegistryChainLive = RegistryChain.layer.pipe(
  Layer.provide(Env.layer)
);
