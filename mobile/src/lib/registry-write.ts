import { Effect } from "effect";
import { isAddress } from "viem";

import { createRegistryWrite, RegistryWriteError } from "./registry-write-core";
import type {
  RecoverOwnerSubmission,
  RegistryWriteClient,
  WipeDevicesSubmission,
} from "./registry-write-core";

export {
  createRegistryWrite,
  RegistryWriteError,
  submitRecoverOwner,
  submitWipeDevices,
} from "./registry-write-core";
export type {
  RecoverOwnerSubmission,
  RegistryWriteClient,
  RegistryWriteDependencies,
  WipeDevicesSubmission,
} from "./registry-write-core";

/** On-chain wipeDevices / recoverOwner write ABI used by the production facade. */
export const registryWriteAbi = [
  {
    inputs: [
      {
        components: [
          { name: "qid", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint64" },
        ],
        name: "intent",
        type: "tuple",
      },
      { name: "ownerSignature", type: "bytes" },
    ],
    name: "wipeDevices",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        components: [
          { name: "qid", type: "uint256" },
          { name: "newOwner", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint64" },
        ],
        name: "intent",
        type: "tuple",
      },
      { name: "ownerSignature", type: "bytes" },
      { name: "newOwnerSignature", type: "bytes" },
    ],
    name: "recoverOwner",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

interface ConfiguredRegistryWriteDependencies {
  readonly createClient: (
    registryAddress: `0x${string}`
  ) => RegistryWriteClient;
  readonly registryAddress: string | undefined;
}

const configurationFailure = () =>
  Effect.fail(new RegistryWriteError({ operation: "configuration" }));

/**
 * Production registry-write facade. Callers supply a funded write client
 * (wallet / relayer); address comes from app configuration.
 */
export const createConfiguredRegistryWrite = ({
  createClient,
  registryAddress,
}: ConfiguredRegistryWriteDependencies) => {
  if (!(registryAddress && isAddress(registryAddress))) {
    return {
      recoverOwner: (_submission: RecoverOwnerSubmission) =>
        configurationFailure(),
      wipeDevices: (_submission: WipeDevicesSubmission) =>
        configurationFailure(),
    };
  }

  return createRegistryWrite({
    client: createClient(registryAddress),
    recoverAbi: registryWriteAbi,
    registryAddress,
    wipeAbi: registryWriteAbi,
  });
};

/** Default production entry: address from Expo public env; client injected by caller. */
export const createAppRegistryWrite = (
  createClient: (registryAddress: `0x${string}`) => RegistryWriteClient
) =>
  createConfiguredRegistryWrite({
    createClient,
    registryAddress: process.env.EXPO_PUBLIC_REGISTRY_ADDRESS,
  });
