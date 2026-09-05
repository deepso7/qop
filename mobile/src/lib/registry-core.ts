import {
  DeviceKey,
  EthereumAddress,
  Handle,
  Hex32,
  PeerId,
  peerIdFromDeviceKey,
} from "@qop/identity";
import { Data, Effect, Schema } from "effect";
import { keccak256, toBytes } from "viem";

export const registryAbi = [
  {
    inputs: [{ name: "qid", type: "uint256" }],
    name: "account",
    outputs: [
      {
        components: [
          { name: "owner", type: "address" },
          { name: "deviceKey", type: "bytes32" },
          { name: "ownerVersion", type: "uint32" },
          { name: "registeredAt", type: "uint64" },
          { name: "nonce", type: "uint256" },
          { name: "handle", type: "string" },
        ],
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "handleHash", type: "bytes32" }],
    name: "qidByHandleHash",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "owner", type: "address" }],
    name: "qidByOwner",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "deviceKey", type: "bytes32" }],
    name: "qidByDeviceKey",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const CanonicalDeviceKey = DeviceKey.pipe(
  Schema.decodeTo(DeviceKey.pipe(Schema.flip))
);
const EthereumAddressInput = Schema.String.check(
  Schema.isPattern(/^0x[0-9a-f]{40}$/iu)
);
const Hex32Input = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{64}$/iu));
const OwnerVersion = Schema.Int.check(
  Schema.makeFilter((value) => value >= 0 && value <= 2 ** 32 - 1, {
    expected: "a uint32 owner version",
  })
);
const RegisteredAt = Schema.BigInt.check(
  Schema.makeFilter((value) => value >= 0n && value <= 2n ** 64n - 1n, {
    expected: "a uint64 registration timestamp",
  })
);
const ChainQid = Schema.BigInt.check(
  Schema.makeFilter((value) => value >= 0n && value <= 2n ** 256n - 1n, {
    expected: "a uint256 qid",
  })
);
const ContractAccountResult = Schema.Struct({
  deviceKey: Hex32Input,
  handle: Handle,
  nonce: ChainQid,
  owner: EthereumAddressInput,
  ownerVersion: OwnerVersion,
  registeredAt: RegisteredAt,
});

type RegistryContractResult = bigint | typeof ContractAccountResult.Type;

export interface RegistryAccount {
  readonly deviceKey: typeof Hex32.Encoded;
  readonly handle: string;
  readonly owner: string;
  readonly ownerVersion: number;
  readonly peerId: string;
  readonly qid: bigint;
  readonly registeredAt: bigint;
}

export class RegistryReaderError extends Data.TaggedError(
  "RegistryReaderError"
)<{
  readonly operation: "configuration" | "decode" | "invalid-handle" | "rpc";
}> {}

const readerError = (operation: RegistryReaderError["operation"]) =>
  new RegistryReaderError({ operation });

export interface RegistryReadClient {
  readonly readContract: (
    parameters: {
      readonly abi: typeof registryAbi;
      readonly args: readonly unknown[];
      readonly functionName:
        | "account"
        | "qidByDeviceKey"
        | "qidByHandleHash"
        | "qidByOwner";
    },
    options?: {
      readonly signal?: AbortSignal;
    }
  ) => Promise<RegistryContractResult>;
}

const readQid = (value: RegistryContractResult) =>
  Schema.decodeUnknownEffect(ChainQid)(value).pipe(
    Effect.mapError(() => readerError("decode"))
  );

export const createRegistryReader = ({
  client,
}: {
  readonly client: RegistryReadClient;
}) => {
  const readContract = Effect.fn("RegistryReader.readContract")(
    (parameters: Parameters<RegistryReadClient["readContract"]>[0]) =>
      Effect.tryPromise({
        catch: () => readerError("rpc"),
        try: (signal) => client.readContract(parameters, { signal }),
      })
  );

  const account = Effect.fn("RegistryReader.account")(function* (qid: bigint) {
    const result = yield* readContract({
      abi: registryAbi,
      args: [qid],
      functionName: "account",
    });
    const {
      owner: ownerInput,
      deviceKey: deviceKeyInput,
      ownerVersion,
      registeredAt,
      handle,
    } = yield* Schema.decodeUnknownEffect(ContractAccountResult)(result).pipe(
      Effect.mapError(() => readerError("decode"))
    );
    const owner = yield* Schema.decodeUnknownEffect(EthereumAddress)(
      ownerInput.toLowerCase()
    ).pipe(Effect.mapError(() => readerError("decode")));
    const deviceKey = yield* Schema.decodeUnknownEffect(CanonicalDeviceKey)(
      deviceKeyInput.toLowerCase()
    ).pipe(Effect.mapError(() => readerError("decode")));
    const deviceKeyBytes = yield* Schema.decodeUnknownEffect(Hex32)(
      deviceKey
    ).pipe(Effect.mapError(() => readerError("decode")));
    const peerId = yield* peerIdFromDeviceKey(deviceKeyBytes).pipe(
      Effect.flatMap(Schema.encodeEffect(PeerId)),
      Effect.mapError(() => readerError("decode"))
    );
    return {
      deviceKey,
      handle,
      owner,
      ownerVersion,
      peerId,
      qid,
      registeredAt,
    } satisfies RegistryAccount;
  });

  const lookupHandle = Effect.fn("RegistryReader.lookupHandle")(function* (
    input: string
  ) {
    const handle = yield* Schema.decodeUnknownEffect(Handle)(input).pipe(
      Effect.mapError(() => readerError("invalid-handle"))
    );
    const qid = yield* readContract({
      abi: registryAbi,
      args: [keccak256(toBytes(handle))],
      functionName: "qidByHandleHash",
    }).pipe(Effect.flatMap(readQid));
    return qid === 0n ? null : yield* account(qid);
  });

  const lookupOwner = Effect.fn("RegistryReader.lookupOwner")(function* (
    input: string
  ) {
    const owner = yield* Schema.decodeUnknownEffect(EthereumAddress)(
      input.toLowerCase()
    ).pipe(Effect.mapError(() => readerError("decode")));
    const qid = yield* readContract({
      abi: registryAbi,
      args: [owner],
      functionName: "qidByOwner",
    }).pipe(Effect.flatMap(readQid));
    return qid === 0n ? null : yield* account(qid);
  });

  // Transport peerId ↔ deviceKey; resolve identity from the live key, not a claimed handle.
  const lookupDeviceKey = Effect.fn("RegistryReader.lookupDeviceKey")(
    function* (input: string) {
      const deviceKey = yield* Schema.decodeUnknownEffect(CanonicalDeviceKey)(
        input.toLowerCase()
      ).pipe(Effect.mapError(() => readerError("decode")));
      const qid = yield* readContract({
        abi: registryAbi,
        args: [deviceKey],
        functionName: "qidByDeviceKey",
      }).pipe(Effect.flatMap(readQid));
      return qid === 0n ? null : yield* account(qid);
    }
  );

  return { lookupDeviceKey, lookupHandle, lookupOwner };
};
