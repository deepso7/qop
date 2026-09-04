import { Effect } from "effect";
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

const configuredReader = Effect.fn("Registry.configuredReader")(function* () {
  const rpcUrl = process.env.EXPO_PUBLIC_RPC_URL;
  const registryAddress = process.env.EXPO_PUBLIC_REGISTRY_ADDRESS;
  if (!rpcUrl || !registryAddress || !isAddress(registryAddress)) {
    return yield* configurationError();
  }
  yield* Effect.try({
    catch: configurationError,
    try: () => new URL(rpcUrl),
  });
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  return createRegistryReader({
    client: {
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
    },
  });
});

export const lookupHandle = Effect.fn("Registry.lookupHandle")(
  (handle: string) =>
    configuredReader().pipe(
      Effect.flatMap((reader) => reader.lookupHandle(handle))
    )
);

export const lookupOwner = Effect.fn("Registry.lookupOwner")((owner: string) =>
  configuredReader().pipe(Effect.flatMap((reader) => reader.lookupOwner(owner)))
);
