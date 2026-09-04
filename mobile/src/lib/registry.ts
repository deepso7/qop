import { ChainId } from "@qop/identity";
import { Effect, Schema, Semaphore } from "effect";
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
  readonly getChainId: () => Promise<number>;
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
      try: client.getChainId,
    });
    if (BigInt(actualChainId) !== expectedChainId) {
      return yield* configurationError();
    }
    return createRegistryReader({ client });
  });
  const initialization = Semaphore.makeUnsafe(1);
  let initializedReader: ReturnType<typeof createRegistryReader> | undefined;
  const cachedConfiguredReader = initialization.withPermit(
    Effect.gen(function* () {
      if (!initializedReader) {
        initializedReader = yield* configuredReader();
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

  return { lookupHandle, lookupOwner };
};

const configuredRegistry = createConfiguredRegistry({
  createClient: (rpcUrl, registryAddress) => {
    const publicClient = createPublicClient({ transport: http(rpcUrl) });
    return {
      getChainId: () => publicClient.getChainId(),
      readContract: async (parameters) => {
        // SAFETY: The bound address and ABI were validated before this call.
        const result = await publicClient.readContract({
          ...parameters,
          address: registryAddress,
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

export const { lookupHandle, lookupOwner } = configuredRegistry;
