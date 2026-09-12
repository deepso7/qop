import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema, SchemaIssue } from "effect";
import { hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  AddDeviceIntentV1,
  decodeAddDeviceIntentV1,
  decodeIdentityEip712DomainV1,
  decodeRecoverOwnerIntentV1,
  decodeRegisterIntentV1,
  decodeRemoveDeviceIntentV1,
  decodeRotateOwnerIntentV1,
  decodeWipeDevicesIntentV1,
  encodeAddDeviceIntentV1,
  encodeRecoverOwnerIntentV1,
  encodeRegisterIntentV1,
  encodeRemoveDeviceIntentV1,
  encodeRotateOwnerIntentV1,
  encodeWipeDevicesIntentV1,
  hashAddDeviceIntentV1,
  hashRecoverOwnerIntentV1,
  hashRegisterIntentV1,
  hashRemoveDeviceIntentV1,
  hashRotateOwnerIntentV1,
  hashWipeDevicesIntentV1,
  makeAddDeviceIntentTypedDataV1,
  makeRegisterIntentTypedDataV1,
  makeRemoveDeviceIntentTypedDataV1,
  makeRotateOwnerIntentTypedDataV1,
  makeWipeDevicesIntentTypedDataV1,
  normalizeEcdsaSignature,
  recoverAddDeviceIntentSignerV1,
  recoverRecoverOwnerIntentSignerV1,
  recoverRegisterIntentSignerV1,
  recoverRemoveDeviceIntentSignerV1,
  recoverRotateOwnerIntentSignerV1,
  recoverWipeDevicesIntentSignerV1,
  RegisterIntentV1,
  RemoveDeviceIntentV1,
  RotateOwnerIntentV1,
  signRecoverOwnerIntentV1,
  signRegisterIntentV1,
  signWipeDevicesIntentV1,
  WipeDevicesIntentV1,
} from "../src/index.ts";

const PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
const SECOND_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000002";

const encodedDomain = {
  chainId: "11155111",
  verifyingContract: "0x1111111111111111111111111111111111111111",
} as const;

const encodedRegisterIntent = {
  deadline: "1700003600",
  deviceKey: `0x${"02".repeat(32)}`,
  handle: "alice",
  nonce: `0x${"01".repeat(32)}`,
  owner: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
} as const;

const encodedRotateOwnerIntent = {
  deadline: "1700003600",
  newOwner: "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf",
  nonce: "7",
  qid: "42",
} as const;

const encodedRecoverOwnerIntent = {
  deadline: "1700003600",
  newOwner: "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf",
  nonce: "7",
  qid: "42",
} as const;

const encodedAddDeviceIntent = {
  deadline: "1700003600",
  deviceKey: `0x${"09".repeat(32)}`,
  nonce: "9",
  qid: "42",
} as const;

const encodedRemoveDeviceIntent = {
  deadline: "1700003600",
  deviceKey: `0x${"0a".repeat(32)}`,
  nonce: "11",
  qid: "42",
} as const;

const encodedWipeDevicesIntent = {
  deadline: "1700003600",
  nonce: "13",
  qid: "42",
} as const;

const expectedDigests = {
  addDevice:
    "0xc9a7d7b29736e26c6932c8047d84122012260032485952f2df658ccc3b251ca0",
  recoverOwner:
    "0x85177ecb06c719680cffda8b05c8c484a6c9bed3d0aa178aa8e1741170666b34",
  register:
    "0x53dc6c862551e88c6021e67e163d162b1491a6a6b5e92a85196d2f9cea4aca9a",
  removeDevice:
    "0x93d4098944b4086859554efbee5bd6c129c7649ee03b3de63145372fb4717603",
  rotateOwner:
    "0xcfd2c2208d584d29013cb01bbcd1f1ae5cef6c3546b82c682c52a66633e24c6c",
  wipeDevices:
    "0xd21c9fb8cf5859d38503d7428b8c9becf50a46245e1b68e65395c88cd4c98e7b",
} as const;

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

describe("registry intents", () => {
  it.effect("round-trips strict canonical wire values", () =>
    Effect.gen(function* () {
      const register = yield* decodeRegisterIntentV1(encodedRegisterIntent);
      const rotateOwner = yield* decodeRotateOwnerIntentV1(
        encodedRotateOwnerIntent
      );
      const recoverOwner = yield* decodeRecoverOwnerIntentV1(
        encodedRecoverOwnerIntent
      );
      const addDevice = yield* decodeAddDeviceIntentV1(encodedAddDeviceIntent);
      const removeDevice = yield* decodeRemoveDeviceIntentV1(
        encodedRemoveDeviceIntent
      );
      const wipeDevices = yield* decodeWipeDevicesIntentV1(
        encodedWipeDevicesIntent
      );

      assert.deepStrictEqual(
        yield* encodeRegisterIntentV1(register),
        encodedRegisterIntent
      );
      assert.deepStrictEqual(
        yield* encodeRotateOwnerIntentV1(rotateOwner),
        encodedRotateOwnerIntent
      );
      assert.deepStrictEqual(
        yield* encodeRecoverOwnerIntentV1(recoverOwner),
        encodedRecoverOwnerIntent
      );
      assert.deepStrictEqual(
        yield* encodeAddDeviceIntentV1(addDevice),
        encodedAddDeviceIntent
      );
      assert.deepStrictEqual(
        yield* encodeRemoveDeviceIntentV1(removeDevice),
        encodedRemoveDeviceIntent
      );
      assert.deepStrictEqual(
        yield* encodeWipeDevicesIntentV1(wipeDevices),
        encodedWipeDevicesIntent
      );
      assert.strictEqual(register.owner, encodedRegisterIntent.owner);
      assert.strictEqual(rotateOwner.nonce, 7n);
      assert.strictEqual(addDevice.qid, 42n);
      assert.strictEqual(removeDevice.nonce, 11n);
      assert.strictEqual(wipeDevices.nonce, 13n);
    })
  );

  it.effect("pins all registry intent EIP-712 digests", () =>
    Effect.gen(function* () {
      const domain = yield* decodeIdentityEip712DomainV1(encodedDomain);
      const register = yield* decodeRegisterIntentV1(encodedRegisterIntent);
      const rotateOwner = yield* decodeRotateOwnerIntentV1(
        encodedRotateOwnerIntent
      );
      const recoverOwner = yield* decodeRecoverOwnerIntentV1(
        encodedRecoverOwnerIntent
      );
      const addDevice = yield* decodeAddDeviceIntentV1(encodedAddDeviceIntent);
      const removeDevice = yield* decodeRemoveDeviceIntentV1(
        encodedRemoveDeviceIntent
      );
      const wipeDevices = yield* decodeWipeDevicesIntentV1(
        encodedWipeDevicesIntent
      );

      assert.strictEqual(
        yield* hashRegisterIntentV1(domain, register),
        expectedDigests.register
      );
      assert.strictEqual(
        yield* hashRotateOwnerIntentV1(domain, rotateOwner),
        expectedDigests.rotateOwner
      );
      assert.strictEqual(
        yield* hashRecoverOwnerIntentV1(domain, recoverOwner),
        expectedDigests.recoverOwner
      );
      assert.strictEqual(
        yield* hashAddDeviceIntentV1(domain, addDevice),
        expectedDigests.addDevice
      );
      assert.strictEqual(
        yield* hashRemoveDeviceIntentV1(domain, removeDevice),
        expectedDigests.removeDevice
      );
      assert.strictEqual(
        yield* hashWipeDevicesIntentV1(domain, wipeDevices),
        expectedDigests.wipeDevices
      );
    })
  );

  it.effect("matches the Solidity register-intent compatibility vectors", () =>
    Effect.gen(function* () {
      const domain = yield* decodeIdentityEip712DomainV1(encodedDomain);
      for (const [encoded, expected] of [
        [encodedRegisterIntent, expectedDigests.register],
        [
          {
            deadline: "1700000001",
            deviceKey: `0x${"03".repeat(32)}`,
            handle: "0xdeepso",
            nonce: `0x${"04".repeat(32)}`,
            owner: "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf",
          },
          "0x5588faff7c3f5d0f7184f36937cca34a11f0d6293d76570d1d96831d3c9cb3ef",
        ],
        [
          {
            deadline: "18446744073709551615",
            deviceKey: `0x${"05".repeat(32)}`,
            handle: "123kate",
            nonce: `0x${"06".repeat(32)}`,
            owner: "0x6813eb9362372eef6200f3b1dbc3f819671cba69",
          },
          "0x8c73b10b7da9d84c1c0b382ecfe2b7a289b4b94b11e9c5fd792519f0966e92cb",
        ],
        [
          {
            deadline: "42",
            deviceKey: `0x${"07".repeat(32)}`,
            handle: "a_b9",
            nonce: `0x${"08".repeat(32)}`,
            owner: "0x1eff47bc3a10a45d4b230b5d10e37751fe6aa718",
          },
          "0x7bbdd775ad87bf649cc9245b381c601b893609d70606565253c8c5f9f4ae3ad8",
        ],
      ] as const) {
        const intent = yield* decodeRegisterIntentV1(encoded);
        assert.strictEqual(
          yield* hashRegisterIntentV1(domain, intent),
          expected
        );
      }
    })
  );

  it.effect("recovers the signer for every owner action", () =>
    Effect.gen(function* () {
      const account = privateKeyToAccount(PRIVATE_KEY);
      const secondAccount = privateKeyToAccount(SECOND_PRIVATE_KEY);
      const domain = yield* decodeIdentityEip712DomainV1(encodedDomain);
      const register = yield* decodeRegisterIntentV1(encodedRegisterIntent);
      const rotateOwner = yield* decodeRotateOwnerIntentV1(
        encodedRotateOwnerIntent
      );
      const addDevice = yield* decodeAddDeviceIntentV1(encodedAddDeviceIntent);
      const removeDevice = yield* decodeRemoveDeviceIntentV1(
        encodedRemoveDeviceIntent
      );
      const wipeDevices = yield* decodeWipeDevicesIntentV1(
        encodedWipeDevicesIntent
      );

      const registerSignature = yield* Effect.promise(() =>
        account.signTypedData(makeRegisterIntentTypedDataV1(domain, register))
      ).pipe(Effect.flatMap(normalizeEcdsaSignature));
      const rotateOwnerSignature = yield* Effect.promise(() =>
        account.signTypedData(
          makeRotateOwnerIntentTypedDataV1(domain, rotateOwner)
        )
      ).pipe(Effect.flatMap(normalizeEcdsaSignature));
      const newOwnerSignature = yield* Effect.promise(() =>
        secondAccount.signTypedData(
          makeRotateOwnerIntentTypedDataV1(domain, rotateOwner)
        )
      ).pipe(Effect.flatMap(normalizeEcdsaSignature));
      const addDeviceSignature = yield* Effect.promise(() =>
        account.signTypedData(makeAddDeviceIntentTypedDataV1(domain, addDevice))
      ).pipe(Effect.flatMap(normalizeEcdsaSignature));
      const removeDeviceSignature = yield* Effect.promise(() =>
        account.signTypedData(
          makeRemoveDeviceIntentTypedDataV1(domain, removeDevice)
        )
      ).pipe(Effect.flatMap(normalizeEcdsaSignature));
      const wipeDevicesSignature = yield* Effect.promise(() =>
        account.signTypedData(
          makeWipeDevicesIntentTypedDataV1(domain, wipeDevices)
        )
      ).pipe(Effect.flatMap(normalizeEcdsaSignature));

      assert.strictEqual(
        yield* recoverRegisterIntentSignerV1(
          domain,
          register,
          registerSignature
        ),
        encodedRegisterIntent.owner
      );
      assert.strictEqual(
        yield* recoverRotateOwnerIntentSignerV1(
          domain,
          rotateOwner,
          rotateOwnerSignature
        ),
        encodedRegisterIntent.owner
      );
      assert.strictEqual(
        yield* recoverRotateOwnerIntentSignerV1(
          domain,
          rotateOwner,
          newOwnerSignature
        ),
        encodedRotateOwnerIntent.newOwner
      );
      assert.strictEqual(
        yield* recoverAddDeviceIntentSignerV1(
          domain,
          addDevice,
          addDeviceSignature
        ),
        encodedRegisterIntent.owner
      );
      assert.strictEqual(
        yield* recoverRemoveDeviceIntentSignerV1(
          domain,
          removeDevice,
          removeDeviceSignature
        ),
        encodedRegisterIntent.owner
      );
      assert.strictEqual(
        yield* recoverWipeDevicesIntentSignerV1(
          domain,
          wipeDevices,
          wipeDevicesSignature
        ),
        encodedRegisterIntent.owner
      );
    })
  );

  it.effect("signs a registration with owner key bytes", () =>
    Effect.gen(function* () {
      const domain = yield* decodeIdentityEip712DomainV1(encodedDomain);
      const intent = yield* decodeRegisterIntentV1(encodedRegisterIntent);
      const signature = yield* signRegisterIntentV1(
        domain,
        intent,
        hexToBytes(PRIVATE_KEY)
      );

      assert.strictEqual(
        yield* recoverRegisterIntentSignerV1(domain, intent, signature),
        encodedRegisterIntent.owner
      );
    })
  );

  it.effect("keeps every intent schema strict", () =>
    Effect.gen(function* () {
      for (const [schema, encoded, message] of [
        [
          RegisterIntentV1,
          encodedRegisterIntent,
          "Unexpected registration intent field",
        ],
        [
          RotateOwnerIntentV1,
          encodedRotateOwnerIntent,
          "Unexpected owner rotation intent field",
        ],
        [
          AddDeviceIntentV1,
          encodedAddDeviceIntent,
          "Unexpected add-device intent field",
        ],
        [
          RemoveDeviceIntentV1,
          encodedRemoveDeviceIntent,
          "Unexpected remove-device intent field",
        ],
        [
          WipeDevicesIntentV1,
          encodedWipeDevicesIntent,
          "Unexpected wipe-devices intent field",
        ],
      ] as const) {
        const error = yield* Schema.decodeUnknownEffect(schema)({
          ...encoded,
          unexpected: true,
        }).pipe(Effect.flip);
        assert.deepStrictEqual(formatIssue(error.issue).issues, [
          { message, path: ["unexpected"] },
        ]);
      }
    })
  );

  it.effect("rejects zero device keys", () =>
    Effect.gen(function* () {
      const registerError = yield* decodeRegisterIntentV1({
        ...encodedRegisterIntent,
        deviceKey: `0x${"00".repeat(32)}`,
      }).pipe(Effect.flip);
      assert.deepStrictEqual(formatIssue(registerError.issue).issues, [
        { message: "Expected a non-zero device key", path: ["deviceKey"] },
      ]);

      const addError = yield* decodeAddDeviceIntentV1({
        ...encodedAddDeviceIntent,
        deviceKey: `0x${"00".repeat(32)}`,
      }).pipe(Effect.flip);
      assert.deepStrictEqual(formatIssue(addError.issue).issues, [
        { message: "Expected a non-zero device key", path: ["deviceKey"] },
      ]);

      const removeError = yield* decodeRemoveDeviceIntentV1({
        ...encodedRemoveDeviceIntent,
        deviceKey: `0x${"00".repeat(32)}`,
      }).pipe(Effect.flip);
      assert.deepStrictEqual(formatIssue(removeError.issue).issues, [
        { message: "Expected a non-zero device key", path: ["deviceKey"] },
      ]);
    })
  );

  it.effect("signs WipeDevicesIntentV1 with the owner key", () =>
    Effect.gen(function* () {
      const domain = yield* decodeIdentityEip712DomainV1(encodedDomain);
      const wipeDevices = yield* decodeWipeDevicesIntentV1(
        encodedWipeDevicesIntent
      );
      const signature = yield* signWipeDevicesIntentV1(
        domain,
        wipeDevices,
        hexToBytes(PRIVATE_KEY)
      );

      assert.strictEqual(
        yield* recoverWipeDevicesIntentSignerV1(domain, wipeDevices, signature),
        encodedRegisterIntent.owner
      );
    })
  );

  it.effect("signs RecoverOwnerIntentV1 with the owner key", () =>
    Effect.gen(function* () {
      const domain = yield* decodeIdentityEip712DomainV1(encodedDomain);
      const recoverOwner = yield* decodeRecoverOwnerIntentV1(
        encodedRecoverOwnerIntent
      );
      const signature = yield* signRecoverOwnerIntentV1(
        domain,
        recoverOwner,
        hexToBytes(PRIVATE_KEY)
      );

      assert.strictEqual(
        yield* recoverRecoverOwnerIntentSignerV1(
          domain,
          recoverOwner,
          signature
        ),
        encodedRegisterIntent.owner
      );
    })
  );
});
