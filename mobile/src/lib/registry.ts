import { ChainId } from "@qop/identity";
import { Effect, Result, Schema, Semaphore } from "effect";
import { createPublicClient, http, isAddress } from "viem";

import { createRegistryReader, RegistryReaderError } from "./registry-core";
import type { RegistryReadClient } from "./registry-core";

export {
  createRegistryReader,
  RegistryReaderError,
  registryAbi,
} from "./registry-core";
export type { RegistryAccount, RegistryReadClient } from "./registry-core";

const configurationError = () =>
  new RegistryReaderError({ operation: "configuration" });

interface ConfiguredRegistryClient extends RegistryReadClient {
  readonly getChainId: (options?: {
    readonly signal?: AbortSignal;
  }) => Promise<number>;
}

interface ConfiguredRegistryDependencies {
  readonly createClient: (
    rpcUrl: string,
    registryAddress: `0x${string}`
  ) => ConfiguredRegistryClient;
  readonly registryAddress: string | undefined;
  readonly registryChainId: string | undefined;
  readonly rpcUrl: string | undefined;
}

export const createConfiguredRegistry = ({
  createClient,
  registryAddress,
  registryChainId,
  rpcUrl,
}: ConfiguredRegistryDependencies) => {
  const configuredReader = Effect.fn("Registry.configuredReader")(function* () {
    if (
      !rpcUrl ||
      !registryAddress ||
      !registryChainId ||
      !isAddress(registryAddress)
    ) {
      return yield* configurationError();
    }
    yield* Effect.try({
      catch: configurationError,
      try: () => new URL(rpcUrl),
    });
    const expectedChainId = yield* Schema.decodeUnknownEffect(ChainId)(
      registryChainId
    ).pipe(Effect.mapError(configurationError));
    const client = createClient(rpcUrl, registryAddress);
    const actualChainId = yield* Effect.tryPromise({
      catch: () => new RegistryReaderError({ operation: "rpc" }),
      try: (signal) => client.getChainId({ signal }),
    });
    if (BigInt(actualChainId) !== expectedChainId) {
      return yield* configurationError();
    }
    return createRegistryReader({ client });
  });
  const initialization = Semaphore.makeUnsafe(1);
  let initializedReader: ReturnType<typeof createRegistryReader> | undefined;
  let permanentError: RegistryReaderError | undefined;
  const cachedConfiguredReader = initialization.withPermit(
    Effect.gen(function* () {
      if (permanentError) {
        return yield* permanentError;
      }
      if (!initializedReader) {
        const result = yield* configuredReader().pipe(Effect.result);
        if (Result.isFailure(result)) {
          if (result.failure.operation === "configuration") {
            permanentError = result.failure;
          }
          return yield* result.failure;
        }
        initializedReader = result.success;
      }
      return initializedReader;
    })
  );

  const lookupHandle = Effect.fn("Registry.lookupHandle")((handle: string) =>
    cachedConfiguredReader.pipe(
      Effect.flatMap((reader) => reader.lookupHandle(handle))
    )
  );
  const lookupOwner = Effect.fn("Registry.lookupOwner")((owner: string) =>
    cachedConfiguredReader.pipe(
      Effect.flatMap((reader) => reader.lookupOwner(owner))
    )
  );
  const lookupDeviceKey = Effect.fn("Registry.lookupDeviceKey")(
    (deviceKey: string) =>
      cachedConfiguredReader.pipe(
        Effect.flatMap((reader) => reader.lookupDeviceKey(deviceKey))
      )
  );
  const listActiveDevices = Effect.fn("Registry.listActiveDevices")(
    (qid: bigint) =>
      cachedConfiguredReader.pipe(
        Effect.flatMap((reader) => reader.listActiveDevices(qid))
      )
  );

  return { listActiveDevices, lookupDeviceKey, lookupHandle, lookupOwner };
};

const configuredRegistry = createConfiguredRegistry({
  createClient: (rpcUrl, registryAddress) => {
    const publicClient = createPublicClient({ transport: http(rpcUrl) });
    return {
      getChainId: async ({ signal } = {}) => {
        const chainId = await publicClient.request(
          { method: "eth_chainId" },
          { dedupe: true, signal }
        );
        return Number(chainId);
      },
      // Membership freshness depends on a current head — never reuse a
      // deduped eth_blockNumber that could lag behind (or ahead of) eth_call.
      getBlockNumber: async ({ signal } = {}) => {
        const blockNumber = await publicClient.request(
          { method: "eth_blockNumber" },
          { dedupe: false, signal }
        );
        return BigInt(blockNumber);
      },
      readContract: async (parameters, { signal } = {}) => {
        const { blockNumber, ...rest } = parameters;
        // SAFETY: The bound address and ABI were validated before this call.
        const result = await publicClient.readContract({
          ...rest,
          address: registryAddress,
          ...(blockNumber === undefined ? {} : { blockNumber }),
          requestOptions: { signal },
        } as Parameters<typeof publicClient.readContract>[0]);
        // SAFETY: The fixed ABI limits viem's result to the registry result union.
        return result as Awaited<
          ReturnType<RegistryReadClient["readContract"]>
        >;
      },
    };
  },
  registryAddress: process.env.EXPO_PUBLIC_REGISTRY_ADDRESS,
  registryChainId: process.env.EXPO_PUBLIC_REGISTRY_CHAIN_ID,
  rpcUrl: process.env.EXPO_PUBLIC_RPC_URL,
});

export const { listActiveDevices, lookupDeviceKey, lookupHandle, lookupOwner } =
  configuredRegistry;
