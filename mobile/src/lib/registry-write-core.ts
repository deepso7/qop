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

export interface RecoverOwnerSubmission {
  readonly deadline: bigint;
  readonly newOwner: `0x${string}`;
  readonly newOwnerSignature: `0x${string}`;
  readonly nonce: bigint;
  readonly ownerSignature: `0x${string}`;
  readonly qid: bigint;
}

export interface RegistryWriteClient {
  readonly writeContract: (parameters: {
    readonly abi: readonly unknown[];
    readonly address: `0x${string}`;
    readonly args: readonly unknown[];
    readonly functionName: "recoverOwner" | "wipeDevices";
  }) => Promise<`0x${string}`>;
}

/** Device-only wipe. Does not rotate owner — not completed compromise recovery. */
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

/** Completed owner recovery: rotate owner and wipe all devices atomically. */
export const submitRecoverOwner = Effect.fn("RegistryWrite.submitRecoverOwner")(
  function* ({
    client,
    recoverAbi,
    registryAddress,
    submission,
  }: {
    readonly client: RegistryWriteClient;
    readonly recoverAbi: readonly unknown[];
    readonly registryAddress: `0x${string}`;
    readonly submission: RecoverOwnerSubmission;
  }) {
    return yield* Effect.tryPromise({
      catch: () => new RegistryWriteError({ operation: "rpc" }),
      try: () =>
        client.writeContract({
          abi: recoverAbi,
          address: registryAddress,
          args: [
            {
              deadline: submission.deadline,
              newOwner: submission.newOwner,
              nonce: submission.nonce,
              qid: submission.qid,
            },
            submission.ownerSignature,
            submission.newOwnerSignature,
          ],
          functionName: "recoverOwner",
        }),
    });
  }
);
