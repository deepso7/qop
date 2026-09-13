import { assert, layer } from "@effect/vitest";
import {
  decodeAddDeviceIntentV1,
  decodeIdentityEip712DomainV1,
  encodeAddDeviceIntentV1,
  hashAddDeviceIntentV1,
  makeAddDeviceIntentTypedDataV1,
} from "@qop/identity";
import { Effect, Layer, Option } from "effect";
import { encodeAbiParameters, keccak256, pad, toBytes, toHex } from "viem";
import type { Hash, Log } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { DeviceActionChain } from "../src/device-action/chain.ts";
import type { DeviceActionReceipt } from "../src/device-action/chain.ts";
import { DeviceActionEnrollment } from "../src/device-action/enrollment.ts";
import { DeviceActionRelayer } from "../src/device-action/relayer.ts";
import {
  DeviceActionInFlightConflict,
  DeviceActionStore,
} from "../src/device-action/store.ts";
import { Env } from "../src/env.ts";
import type { RegistryAccount } from "../src/registry/types.ts";
import { testAddress, testHash } from "./support/ethereum.ts";
import { TestDatabaseLive } from "./support/registration-database.ts";

const OWNER_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
const ownerAccount = privateKeyToAccount(OWNER_PRIVATE_KEY);
const owner = testAddress(ownerAccount.address.toLowerCase());
const REGISTRY_ADDRESS = testAddress(
  "0x1111111111111111111111111111111111111111"
);
const transactionHash = testHash("device-action");
const DEVICE_KEY = testHash("cli-device");

const domain = Effect.runSync(
  decodeIdentityEip712DomainV1({
    chainId: "31337",
    verifyingContract: REGISTRY_ADDRESS,
  })
);

const EnvTestLive = Layer.succeed(
  Env,
  Env.of({
    CHAIN_ID: 31_337n,
    DATABASE_URL: "postgresql://test",
    PORT: 3000,
    REGISTRATION_PRIVATE_KEY: OWNER_PRIVATE_KEY,
    REGISTRY_ADDRESS,
    REGISTRY_CONFIRMATIONS: 0,
    RELAYER_PRIVATE_KEY: OWNER_PRIVATE_KEY,
    RPC_URL: new URL("http://127.0.0.1:8545"),
  })
);

const account: RegistryAccount = {
  devices: [testHash("phone")],
  handle: "alice",
  nonce: 9n,
  owner,
  ownerVersion: 0,
  qid: 42n,
  registeredAt: 0n,
};

let receipts = new Map<Hash, DeviceActionReceipt>();

const DeviceActionChainTestLive = Layer.sync(DeviceActionChain, () => {
  receipts = new Map();
  return DeviceActionChain.of({
    account: () => Effect.succeed(account),
    blockTimestamp: Effect.succeed(1_700_000_000n),
    deviceKeyRemoved: () => Effect.succeed(false),
    latestBlock: Effect.succeed(100n),
    qidByDeviceKey: () => Effect.succeed(null),
    receipt: (hash) => Effect.succeed(receipts.get(hash) ?? null),
    simulate: () => Effect.void,
  });
});

const RelayerTestLive = Layer.succeed(
  DeviceActionRelayer,
  DeviceActionRelayer.of({
    broadcast: (prepared) => Effect.succeed(prepared.transactionHash),
    pendingNonce: Effect.succeed(0n),
    prepare: () =>
      Effect.succeed({
        serializedTransaction: "0x02aa",
        transactionHash,
      }),
  })
);

const EnrollmentTestLive = DeviceActionEnrollment.layer.pipe(
  Layer.provideMerge(
    DeviceActionStore.layer.pipe(Layer.provide(TestDatabaseLive))
  ),
  Layer.provide(DeviceActionChainTestLive),
  Layer.provide(RelayerTestLive),
  Layer.provide(EnvTestLive)
);

// SAFETY: Test logs only need the topic/data fields matchingDeviceActionEvent reads.
const addEventLog = (qid: bigint, deviceKey: Hash, nonce: bigint): Log =>
  ({
    address: REGISTRY_ADDRESS,
    blockHash: testHash("block"),
    blockNumber: 100n,
    data: encodeAbiParameters([{ type: "uint256" }], [nonce]),
    logIndex: 0,
    removed: false,
    topics: [
      keccak256(toBytes("DeviceAdded(uint256,bytes32,uint256)")),
      pad(toHex(qid), { size: 32 }),
      deviceKey,
    ],
    transactionHash,
    transactionIndex: 0,
  }) as Log;

const encodedIntentFor = (qid: string, deadline: string) =>
  ({
    deadline,
    deviceKey: DEVICE_KEY,
    nonce: "9",
    qid,
  }) as const;

layer(EnrollmentTestLive, { timeout: "30 seconds" })((it) => {
  it.effect("submits an add, then confirms from receipt plus event", () =>
    Effect.gen(function* () {
      receipts.clear();
      const enrollment = yield* DeviceActionEnrollment;
      const encodedIntent = encodedIntentFor("42", "1700000600");
      const intent = yield* decodeAddDeviceIntentV1(encodedIntent);
      const digest = yield* hashAddDeviceIntentV1(domain, intent);
      const ownerSignature = yield* Effect.promise(() =>
        ownerAccount.signTypedData(
          makeAddDeviceIntentTypedDataV1(domain, intent)
        )
      );
      const encoded = yield* encodeAddDeviceIntentV1(intent);
      receipts.set(transactionHash, {
        blockNumber: 100n,
        logs: [addEventLog(42n, DEVICE_KEY, 9n)],
        status: "success",
      });

      const submitted = yield* enrollment.submit({
        intent: encoded,
        operation: "add",
        ownerSignature,
      });
      assert.strictEqual(submitted.digest, digest);
      assert.strictEqual(submitted.status, "confirmed");
      const store = yield* DeviceActionStore;
      const stored = yield* store.get(digest);
      assert.strictEqual(Option.isSome(stored), true);
    })
  );

  it.effect(
    "replays a confirmed digest even after the account nonce moved",
    () =>
      Effect.gen(function* () {
        receipts.clear();
        const enrollment = yield* DeviceActionEnrollment;
        const encodedIntent = encodedIntentFor("43", "1700000600");
        const intent = yield* decodeAddDeviceIntentV1(encodedIntent);
        const digest = yield* hashAddDeviceIntentV1(domain, intent);
        const ownerSignature = yield* Effect.promise(() =>
          ownerAccount.signTypedData(
            makeAddDeviceIntentTypedDataV1(domain, intent)
          )
        );
        const encoded = yield* encodeAddDeviceIntentV1(intent);
        receipts.set(transactionHash, {
          blockNumber: 100n,
          logs: [addEventLog(43n, DEVICE_KEY, 9n)],
          status: "success",
        });
        yield* enrollment.submit({
          intent: encoded,
          operation: "add",
          ownerSignature,
        });
        const replay = yield* enrollment.submit({
          intent: encoded,
          operation: "add",
          ownerSignature,
        });
        assert.strictEqual(replay.status, "confirmed");
        assert.strictEqual(replay.digest, digest);
      })
  );

  it.effect("returns an in-flight conflict for a different digest", () =>
    Effect.gen(function* () {
      receipts.clear();
      const enrollment = yield* DeviceActionEnrollment;
      const encodedIntent = encodedIntentFor("44", "1700000600");
      const intent = yield* decodeAddDeviceIntentV1(encodedIntent);
      const ownerSignature = yield* Effect.promise(() =>
        ownerAccount.signTypedData(
          makeAddDeviceIntentTypedDataV1(domain, intent)
        )
      );
      const encoded = yield* encodeAddDeviceIntentV1(intent);
      yield* enrollment.submit({
        intent: encoded,
        operation: "add",
        ownerSignature,
      });
      const otherIntent = yield* decodeAddDeviceIntentV1(
        encodedIntentFor("44", "1700000599")
      );
      const otherSignature = yield* Effect.promise(() =>
        ownerAccount.signTypedData(
          makeAddDeviceIntentTypedDataV1(domain, otherIntent)
        )
      );
      const otherEncoded = yield* encodeAddDeviceIntentV1(otherIntent);
      const result = yield* enrollment
        .submit({
          intent: otherEncoded,
          operation: "add",
          ownerSignature: otherSignature,
        })
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.strictEqual(
          result.failure instanceof DeviceActionInFlightConflict,
          true
        );
      }
    })
  );
});
