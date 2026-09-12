import { Context, Data, Effect, Layer } from "effect";
import {
  createPublicClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  pad,
  parseAbi,
  toBytes,
  toHex,
} from "viem";
import type { Hash, Hex, Log } from "viem";

import { Env } from "../env.ts";
import { registryReadAbi } from "../registry/abi.ts";
import type { RegistryAccount } from "../registry/types.ts";
import type { DeviceActionIntent } from "./relayer.ts";
import type { DeviceActionOperation } from "./types.ts";

const registryWriteAbi = parseAbi([
  "function addDevice((uint256 qid, bytes32 deviceKey, uint256 nonce, uint64 deadline) intent, bytes ownerSignature)",
  "function removeDevice((uint256 qid, bytes32 deviceKey, uint256 nonce, uint64 deadline) intent, bytes ownerSignature)",
]);

const registryEvents = {
  add: keccak256(toBytes("DeviceAdded(uint256,bytes32,uint256)")),
  remove: keccak256(toBytes("DeviceRemoved(uint256,bytes32,uint256)")),
} as const;

export const matchingDeviceActionEvent = (
  logs: readonly Log[],
  operation: DeviceActionOperation,
  qid: bigint,
  deviceKey: Hash,
  nonce: bigint
) => {
  const selector =
    operation === "add" ? registryEvents.add : registryEvents.remove;
  const qidTopic = pad(toHex(qid), { size: 32 }).toLowerCase();
  const keyTopic = deviceKey.toLowerCase();
  const nonceData = encodeAbiParameters(
    [{ type: "uint256" }],
    [nonce]
  ).toLowerCase();
  return logs.some((log) => {
    const topic0 = log.topics[0]?.toLowerCase();
    const topic1 = log.topics[1]?.toLowerCase();
    const topic2 = log.topics[2]?.toLowerCase();
    return (
      topic0 === selector &&
      topic1 === qidTopic &&
      topic2 === keyTopic &&
      log.data.toLowerCase() === nonceData
    );
  });
};

export class DeviceActionChainError extends Data.TaggedError(
  "DeviceActionChainError"
)<{
  readonly operation: "account" | "receipt" | "simulate" | "timestamp";
}> {}

export interface DeviceActionReceipt {
  readonly blockNumber: bigint;
  readonly logs: readonly Log[];
  readonly status: "reverted" | "success";
}

export interface DeviceActionChainContract {
  readonly account: (
    qid: bigint
  ) => Effect.Effect<RegistryAccount, DeviceActionChainError>;
  readonly blockTimestamp: Effect.Effect<bigint, DeviceActionChainError>;
  readonly deviceKeyRemoved: (
    deviceKey: Hash
  ) => Effect.Effect<boolean, DeviceActionChainError>;
  readonly latestBlock: Effect.Effect<bigint, DeviceActionChainError>;
  readonly qidByDeviceKey: (
    deviceKey: Hash
  ) => Effect.Effect<bigint | null, DeviceActionChainError>;
  readonly receipt: (
    transactionHash: Hash
  ) => Effect.Effect<DeviceActionReceipt | null, DeviceActionChainError>;
  readonly simulate: (
    operation: DeviceActionOperation,
    intent: DeviceActionIntent,
    ownerSignature: Hex
  ) => Effect.Effect<void, DeviceActionChainError>;
}

export class DeviceActionChain extends Context.Service<
  DeviceActionChain,
  DeviceActionChainContract
>()("@qop/api/DeviceActionChain") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const env = yield* Env;
      const client = createPublicClient({
        transport: http(env.RPC_URL.toString(), { batch: true }),
      });
      const registryAddress = getAddress(env.REGISTRY_ADDRESS);
      const confirmations = BigInt(env.REGISTRY_CONFIRMATIONS);

      const pinnedHead = Effect.fn("DeviceActionChain.pinnedHead")(
        function* () {
          const latest = yield* Effect.tryPromise({
            catch: () => new DeviceActionChainError({ operation: "account" }),
            try: () => client.getBlockNumber(),
          });
          if (latest < confirmations) {
            return yield* new DeviceActionChainError({ operation: "account" });
          }
          return latest - confirmations;
        }
      );

      const account = Effect.fn("DeviceActionChain.account")(function* (
        qid: bigint
      ) {
        const blockNumber = yield* pinnedHead();
        const result = yield* Effect.tryPromise({
          catch: () => new DeviceActionChainError({ operation: "account" }),
          try: async () => {
            const [row, devices] = await Promise.all([
              client.readContract({
                abi: registryReadAbi,
                address: registryAddress,
                args: [qid],
                blockNumber,
                functionName: "account",
              }),
              client.readContract({
                abi: registryReadAbi,
                address: registryAddress,
                args: [qid],
                blockNumber,
                functionName: "listActiveDevices",
              }),
            ]);
            return { devices, row };
          },
        });
        return {
          devices: result.devices,
          handle: result.row.handle,
          nonce: result.row.nonce,
          // SAFETY: viem decodes the contract's address return as an Address.
          owner: result.row.owner.toLowerCase() as RegistryAccount["owner"],
          ownerVersion: result.row.ownerVersion,
          qid,
          registeredAt: result.row.registeredAt,
        } satisfies RegistryAccount;
      });

      const blockTimestamp = Effect.fn("DeviceActionChain.blockTimestamp")(
        function* () {
          const blockNumber = yield* pinnedHead();
          const block = yield* Effect.tryPromise({
            catch: () => new DeviceActionChainError({ operation: "timestamp" }),
            try: () => client.getBlock({ blockNumber }),
          });
          return block.timestamp;
        }
      )();

      const latestBlock = Effect.tryPromise({
        catch: () => new DeviceActionChainError({ operation: "receipt" }),
        try: () => client.getBlockNumber(),
      });

      const qidByDeviceKey = Effect.fn("DeviceActionChain.qidByDeviceKey")(
        function* (deviceKey: Hash) {
          const blockNumber = yield* pinnedHead();
          const qid = yield* Effect.tryPromise({
            catch: () => new DeviceActionChainError({ operation: "account" }),
            try: () =>
              client.readContract({
                abi: registryReadAbi,
                address: registryAddress,
                args: [deviceKey],
                blockNumber,
                functionName: "qidByDeviceKey",
              }),
          });
          return qid === 0n ? null : qid;
        }
      );

      const deviceKeyRemoved = Effect.fn("DeviceActionChain.deviceKeyRemoved")(
        function* (deviceKey: Hash) {
          const blockNumber = yield* pinnedHead();
          return yield* Effect.tryPromise({
            catch: () => new DeviceActionChainError({ operation: "account" }),
            try: () =>
              client.readContract({
                abi: parseAbi([
                  "function deviceKeyRemoved(bytes32 deviceKey) view returns (bool)",
                ]),
                address: registryAddress,
                args: [deviceKey],
                blockNumber,
                functionName: "deviceKeyRemoved",
              }),
          });
        }
      );

      const simulate = Effect.fn("DeviceActionChain.simulate")(function* (
        operation: DeviceActionOperation,
        intent: DeviceActionIntent,
        ownerSignature: Hex
      ) {
        yield* Effect.tryPromise({
          catch: () => new DeviceActionChainError({ operation: "simulate" }),
          try: () =>
            client.simulateContract({
              abi: registryWriteAbi,
              address: registryAddress,
              args: [
                {
                  deadline: intent.deadline,
                  deviceKey: toHex(intent.deviceKey),
                  nonce: intent.nonce,
                  qid: intent.qid,
                },
                ownerSignature,
              ],
              functionName: operation === "add" ? "addDevice" : "removeDevice",
            }),
        });
      });

      const receipt = Effect.fn("DeviceActionChain.receipt")(function* (
        transactionHash: Hash
      ) {
        const found = yield* Effect.tryPromise({
          catch: () => new DeviceActionChainError({ operation: "receipt" }),
          try: () => client.getTransactionReceipt({ hash: transactionHash }),
        }).pipe(Effect.catch(() => Effect.succeed(null)));
        if (!found) {
          return null;
        }
        return {
          blockNumber: found.blockNumber,
          logs: found.logs,
          status: found.status === "success" ? "success" : "reverted",
        } satisfies DeviceActionReceipt;
      });

      return DeviceActionChain.of({
        account,
        blockTimestamp,
        deviceKeyRemoved,
        latestBlock,
        qidByDeviceKey,
        receipt,
        simulate,
      });
    })
  );
}

export const DeviceActionChainLive = DeviceActionChain.layer.pipe(
  Layer.provide(Env.layer)
);
