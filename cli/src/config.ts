import { ChainId } from "@qop/identity";
import { createRegistryReader } from "@qop/protocol";
import type { RegistryReadClient } from "@qop/protocol";
import { Data, Effect, Schema } from "effect";
import { createPublicClient, http, isAddress } from "viem";

export class CliConfigError extends Data.TaggedError("CliConfigError")<{
  readonly operation: "env" | "platform";
}> {}

const envError = new CliConfigError({ operation: "env" });

export const cliRelays = () =>
  (process.env.QOP_RELAY_ADDRS ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);

export const configuredRegistry = Effect.fn("cli.configuredRegistry")(
  function* () {
    const rpcUrl = process.env.QOP_RPC_URL;
    const registryAddress = process.env.QOP_REGISTRY_ADDRESS;
    const chainIdInput = process.env.QOP_REGISTRY_CHAIN_ID ?? "31337";
    const apiUrl = process.env.QOP_API_URL;
    if (!rpcUrl || !registryAddress || !isAddress(registryAddress)) {
      return yield* envError;
    }
    const chainId = yield* Schema.decodeUnknownEffect(ChainId)(
      chainIdInput
    ).pipe(Effect.mapError(() => envError));
    const publicClient = createPublicClient({ transport: http(rpcUrl) });
    const reader = createRegistryReader({
      client: {
        getBlock: async ({ blockNumber, signal } = {}) => {
          const block = await publicClient.request(
            {
              method: "eth_getBlockByNumber",
              params: [
                blockNumber === undefined
                  ? "latest"
                  : `0x${blockNumber.toString(16)}`,
                false,
              ],
            },
            { signal }
          );
          if (!block) {
            throw new Error("Block not found");
          }
          return { timestamp: BigInt(block.timestamp) };
        },
        getBlockNumber: async ({ signal } = {}) => {
          const blockNumber = await publicClient.request(
            { method: "eth_blockNumber" },
            { signal }
          );
          return BigInt(blockNumber);
        },
        readContract: async (parameters, { signal } = {}) => {
          const { blockNumber, ...rest } = parameters;
          const request =
            blockNumber === undefined
              ? {
                  ...rest,
                  address: registryAddress,
                  requestOptions: { signal },
                }
              : {
                  ...rest,
                  address: registryAddress,
                  blockNumber,
                  requestOptions: { signal },
                };
          const result = await publicClient.readContract(
            // SAFETY: The bound address and ABI were validated before this call.
            request as Parameters<typeof publicClient.readContract>[0]
          );
          // SAFETY: The fixed ABI limits viem's result to the registry result union.
          return result as Awaited<
            ReturnType<RegistryReadClient["readContract"]>
          >;
        },
      },
    });
    return {
      apiUrl: apiUrl?.replace(/\/$/u, "") ?? null,
      chainId: chainId.toString(),
      reader,
      registryAddress: registryAddress.toLowerCase(),
      rpcUrl,
    };
  }
);
