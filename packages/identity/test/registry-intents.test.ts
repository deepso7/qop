import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema, SchemaIssue } from "effect";
import { hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  decodeIdentityEip712DomainV1,
  decodeRegisterIntentV1,
  decodeRotateDeviceIntentV1,
  decodeRotateOwnerIntentV1,
  encodeRegisterIntentV1,
  encodeRotateDeviceIntentV1,
  encodeRotateOwnerIntentV1,
  hashRegisterIntentV1,
  hashRotateDeviceIntentV1,
  hashRotateOwnerIntentV1,
  makeRegisterIntentTypedDataV1,
  makeRotateDeviceIntentTypedDataV1,
  makeRotateOwnerIntentTypedDataV1,
  normalizeEcdsaSignature,
  recoverRegisterIntentSignerV1,
  recoverRotateDeviceIntentSignerV1,
  recoverRotateOwnerIntentSignerV1,
  RegisterIntentV1,
  RotateDeviceIntentV1,
  RotateOwnerIntentV1,
  signRegisterIntentV1,
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

const encodedRotateDeviceIntent = {
  deadline: "1700003600",
  newDeviceKey: `0x${"09".repeat(32)}`,
  nonce: "9",
  qid: "42",
} as const;

const expectedDigests = {
  register:
    "0x53dc6c862551e88c6021e67e163d162b1491a6a6b5e92a85196d2f9cea4aca9a",
  rotateDevice:
    "0x862b85ff610fa552a28ef5c22ddde5aa7a7eceb8590b7460c3cb4f26768be180",
  rotateOwner:
    "0xcfd2c2208d584d29013cb01bbcd1f1ae5cef6c3546b82c682c52a66633e24c6c",
} as const;

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

describe("registry intents", () => {
  it.effect("round-trips strict canonical wire values", () =>
    Effect.gen(function* () {
      const register = yield* decodeRegisterIntentV1(encodedRegisterIntent);
      const rotateOwner = yield* decodeRotateOwnerIntentV1(
        encodedRotateOwnerIntent
      );
      const rotateDevice = yield* decodeRotateDeviceIntentV1(
        encodedRotateDeviceIntent
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
        yield* encodeRotateDeviceIntentV1(rotateDevice),
        encodedRotateDeviceIntent
      );
      assert.strictEqual(register.owner, encodedRegisterIntent.owner);
      assert.strictEqual(rotateOwner.nonce, 7n);
      assert.strictEqual(rotateDevice.qid, 42n);
    })
  );

  it.effect("pins all registry intent EIP-712 digests", () =>
    Effect.gen(function* () {
      const domain = yield* decodeIdentityEip712DomainV1(encodedDomain);
      const register = yield* decodeRegisterIntentV1(encodedRegisterIntent);
      const rotateOwner = yield* decodeRotateOwnerIntentV1(
        encodedRotateOwnerIntent
      );
      const rotateDevice = yield* decodeRotateDeviceIntentV1(
        encodedRotateDeviceIntent
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
        yield* hashRotateDeviceIntentV1(domain, rotateDevice),
        expectedDigests.rotateDevice
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
      const rotateDevice = yield* decodeRotateDeviceIntentV1(
        encodedRotateDeviceIntent
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
      const rotateDeviceSignature = yield* Effect.promise(() =>
        account.signTypedData(
          makeRotateDeviceIntentTypedDataV1(domain, rotateDevice)
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
        yield* recoverRotateDeviceIntentSignerV1(
          domain,
          rotateDevice,
          rotateDeviceSignature
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
          RotateDeviceIntentV1,
          encodedRotateDeviceIntent,
          "Unexpected device rotation intent field",
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

      const rotateError = yield* decodeRotateDeviceIntentV1({
        ...encodedRotateDeviceIntent,
        newDeviceKey: `0x${"00".repeat(32)}`,
      }).pipe(Effect.flip);
      assert.deepStrictEqual(formatIssue(rotateError.issue).issues, [
        {
          message: "Expected a non-zero device key",
          path: ["newDeviceKey"],
        },
      ]);
    })
  );
});
