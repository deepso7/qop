import { Data, Effect } from "effect";

export class RegistryWriteError extends Data.TaggedError("RegistryWriteError")<{
  readonly operation: "rpc" | "sign";
}> {}

export interface WipeDevicesSubmission {
  readonly deadline: bigint;
  readonly nonce: bigint;
  readonly qid: bigint;
  readonly signature: `0x${string}`;
}

export interface RegistryWriteClient {
  readonly writeContract: (parameters: {
    readonly abi: readonly unknown[];
    readonly address: `0x${string}`;
    readonly args: readonly unknown[];
    readonly functionName: "wipeDevices";
  }) => Promise<`0x${string}`>;
}

/** Minimal wipeDevices submit path for locked recovery wipe-all. */
export const submitWipeDevices = Effect.fn("RegistryWrite.submitWipeDevices")(
  function* ({
    client,
    registryAddress,
    wipeAbi,
    submission,
  }: {
    readonly client: RegistryWriteClient;
    readonly registryAddress: `0x${string}`;
    readonly wipeAbi: readonly unknown[];
    readonly submission: WipeDevicesSubmission;
  }) {
    return yield* Effect.tryPromise({
      catch: () => new RegistryWriteError({ operation: "rpc" }),
      try: () =>
        client.writeContract({
          abi: wipeAbi,
          address: registryAddress,
          args: [
            {
              deadline: submission.deadline,
              nonce: submission.nonce,
              qid: submission.qid,
            },
            submission.signature,
          ],
          functionName: "wipeDevices",
        }),
    });
  }
);
