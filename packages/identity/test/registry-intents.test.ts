import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema, SchemaIssue } from "effect";
import { privateKeyToAccount } from "viem/accounts";

import {
  decodeIdentityEip712DomainV1,
  decodeRegisterIntentV1,
  decodeRevokeDeviceIntentV1,
  decodeRotateOwnerIntentV1,
  encodeRegisterIntentV1,
  encodeRevokeDeviceIntentV1,
  encodeRotateOwnerIntentV1,
  hashRegisterIntentV1,
  hashRegistrationDeviceCommitmentV1,
  hashRevokeDeviceIntentV1,
  hashRotateOwnerIntentV1,
  makeRegisterIntentTypedDataV1,
  makeRevokeDeviceIntentTypedDataV1,
  makeRotateOwnerIntentTypedDataV1,
  normalizeEcdsaSignature,
  Base64Url32,
  PeerId,
  recoverRegisterIntentSignerV1,
  recoverRevokeDeviceIntentSignerV1,
  recoverRotateOwnerIntentSignerV1,
} from "../src/index.ts";

const PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
const SECOND_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000002";
const EXPECTED_OWNER = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

const encodedDomain = {
  chainId: "11155111",
  verifyingContract: "0x1111111111111111111111111111111111111111",
} as const;

const encodedRegisterIntent = {
  deadline: "1700003600",
  deviceCommitment: `0x${"02".repeat(32)}`,
  handle: "alice",
  nonce: `0x${"01".repeat(32)}`,
  owner: EXPECTED_OWNER.toLowerCase(),
} as const;

const encodedRotateOwnerIntent = {
  deadline: "1700003600",
  newOwner: "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf",
  nonce: "7",
  qid: "42",
} as const;

const encodedRevokeDeviceIntent = {
  certificateDigest:
    "0x0fe41d712ec3ec99c4f62ed1b97c04ec30bd56985f9cf698d3c554db062119bd",
  deadline: "1700003600",
  nonce: "8",
  qid: "42",
} as const;

const expectedDigests = {
  register:
    "0xbf150ff19a934618ba8d52f9d125632f04ce2cf3408ebd81a43356975daf7620",
  revoke: "0xb1c5b8ecf82d6fab75d309bc820a474a36dbe795cc42f891d569379dc5435a6b",
  rotate: "0xcfd2c2208d584d29013cb01bbcd1f1ae5cef6c3546b82c682c52a66633e24c6c",
} as const;

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

describe("registry intents", () => {
  it.effect("pins the initial device commitment", () =>
    Effect.gen(function* () {
      const peerId = yield* Schema.decodeUnknownEffect(PeerId)(
        "12D3KooWEyoppNCUx8Yx66oV9fJnriXwCcXwDDUA2kj6vnc6iDEp"
      );
      const observeToken = yield* Schema.decodeUnknownEffect(Base64Url32)(
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      );
      assert.strictEqual(
        yield* hashRegistrationDeviceCommitmentV1(peerId, observeToken),
        "0x6c4ad152875d4d6bf1b77c99f7f3ce1e8ca6a90b46c8238ed82223d8449d8cfc"
      );
    })
  );

  it.effect("round-trips strict canonical wire values", () =>
    Effect.gen(function* () {
      const register = yield* decodeRegisterIntentV1(encodedRegisterIntent);
      const rotate = yield* decodeRotateOwnerIntentV1(encodedRotateOwnerIntent);
      const revoke = yield* decodeRevokeDeviceIntentV1(
        encodedRevokeDeviceIntent
      );

      assert.deepStrictEqual(
        yield* encodeRegisterIntentV1(register),
        encodedRegisterIntent
      );
      assert.deepStrictEqual(
        yield* encodeRotateOwnerIntentV1(rotate),
        encodedRotateOwnerIntent
      );
      assert.deepStrictEqual(
        yield* encodeRevokeDeviceIntentV1(revoke),
        encodedRevokeDeviceIntent
      );
      assert.strictEqual(register.owner, encodedRegisterIntent.owner);
      assert.strictEqual(rotate.nonce, 7n);
      assert.strictEqual(revoke.qid, 42n);
    })
  );

  it.effect("pins all registry intent EIP-712 digests", () =>
    Effect.gen(function* () {
      const domain = yield* decodeIdentityEip712DomainV1(encodedDomain);
      const register = yield* decodeRegisterIntentV1(encodedRegisterIntent);
      const rotate = yield* decodeRotateOwnerIntentV1(encodedRotateOwnerIntent);
      const revoke = yield* decodeRevokeDeviceIntentV1(
        encodedRevokeDeviceIntent
      );

      const [registerDigest, rotateDigest, revokeDigest] = yield* Effect.all([
        hashRegisterIntentV1(domain, register),
        hashRotateOwnerIntentV1(domain, rotate),
        hashRevokeDeviceIntentV1(domain, revoke),
      ]);

      assert.strictEqual(registerDigest, expectedDigests.register);
      assert.strictEqual(rotateDigest, expectedDigests.rotate);
      assert.strictEqual(revokeDigest, expectedDigests.revoke);
    })
  );

  it.effect("recovers the signer for every owner action", () =>
    Effect.gen(function* () {
      const account = privateKeyToAccount(PRIVATE_KEY);
      const secondAccount = privateKeyToAccount(SECOND_PRIVATE_KEY);
      const domain = yield* decodeIdentityEip712DomainV1(encodedDomain);
      const register = yield* decodeRegisterIntentV1(encodedRegisterIntent);
      const rotate = yield* decodeRotateOwnerIntentV1(encodedRotateOwnerIntent);
      const revoke = yield* decodeRevokeDeviceIntentV1(
        encodedRevokeDeviceIntent
      );

      const registerWalletSignature = yield* Effect.promise(() =>
        account.signTypedData(makeRegisterIntentTypedDataV1(domain, register))
      );
      const rotateWalletSignature = yield* Effect.promise(() =>
        account.signTypedData(makeRotateOwnerIntentTypedDataV1(domain, rotate))
      );
      const newOwnerRotateWalletSignature = yield* Effect.promise(() =>
        secondAccount.signTypedData(
          makeRotateOwnerIntentTypedDataV1(domain, rotate)
        )
      );
      const revokeWalletSignature = yield* Effect.promise(() =>
        account.signTypedData(makeRevokeDeviceIntentTypedDataV1(domain, revoke))
      );

      const registerSignature = yield* normalizeEcdsaSignature(
        registerWalletSignature
      );
      const rotateSignature = yield* normalizeEcdsaSignature(
        rotateWalletSignature
      );
      const newOwnerRotateSignature = yield* normalizeEcdsaSignature(
        newOwnerRotateWalletSignature
      );
      const revokeSignature = yield* normalizeEcdsaSignature(
        revokeWalletSignature
      );

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
          rotate,
          rotateSignature
        ),
        encodedRegisterIntent.owner
      );
      assert.strictEqual(
        yield* recoverRotateOwnerIntentSignerV1(
          domain,
          rotate,
          newOwnerRotateSignature
        ),
        encodedRotateOwnerIntent.newOwner
      );
      assert.strictEqual(
        yield* recoverRevokeDeviceIntentSignerV1(
          domain,
          revoke,
          revokeSignature
        ),
        encodedRegisterIntent.owner
      );
    })
  );

  it.effect("binds recovered signers to the signer and exact payload", () =>
    Effect.gen(function* () {
      const account = privateKeyToAccount(PRIVATE_KEY);
      const secondAccount = privateKeyToAccount(SECOND_PRIVATE_KEY);
      const domain = yield* decodeIdentityEip712DomainV1(encodedDomain);
      const register = yield* decodeRegisterIntentV1(encodedRegisterIntent);
      const rotate = yield* decodeRotateOwnerIntentV1(encodedRotateOwnerIntent);

      const wrongSignerWalletSignature = yield* Effect.promise(() =>
        secondAccount.signTypedData(
          makeRegisterIntentTypedDataV1(domain, register)
        )
      );
      const rotateWalletSignature = yield* Effect.promise(() =>
        account.signTypedData(makeRotateOwnerIntentTypedDataV1(domain, rotate))
      );
      const wrongSignerSignature = yield* normalizeEcdsaSignature(
        wrongSignerWalletSignature
      );
      const rotateSignature = yield* normalizeEcdsaSignature(
        rotateWalletSignature
      );

      const wrongSigner = yield* recoverRegisterIntentSignerV1(
        domain,
        register,
        wrongSignerSignature
      );
      assert.strictEqual(wrongSigner, secondAccount.address.toLowerCase());
      assert.notStrictEqual(wrongSigner, register.owner);

      const alteredRotate = yield* decodeRotateOwnerIntentV1({
        ...encodedRotateOwnerIntent,
        nonce: "8",
      });
      assert.notStrictEqual(
        yield* recoverRotateOwnerIntentSignerV1(
          domain,
          alteredRotate,
          rotateSignature
        ),
        account.address.toLowerCase()
      );
    })
  );

  it.effect("separates every intent digest by chain and registry", () =>
    Effect.gen(function* () {
      const domain = yield* decodeIdentityEip712DomainV1(encodedDomain);
      const otherChain = yield* decodeIdentityEip712DomainV1({
        ...encodedDomain,
        chainId: "1",
      });
      const otherRegistry = yield* decodeIdentityEip712DomainV1({
        ...encodedDomain,
        verifyingContract: "0x2222222222222222222222222222222222222222",
      });
      const register = yield* decodeRegisterIntentV1(encodedRegisterIntent);
      const rotate = yield* decodeRotateOwnerIntentV1(encodedRotateOwnerIntent);
      const revoke = yield* decodeRevokeDeviceIntentV1(
        encodedRevokeDeviceIntent
      );

      const [baseDigests, chainDigests, registryDigests] = yield* Effect.all([
        Effect.all([
          hashRegisterIntentV1(domain, register),
          hashRotateOwnerIntentV1(domain, rotate),
          hashRevokeDeviceIntentV1(domain, revoke),
        ]),
        Effect.all([
          hashRegisterIntentV1(otherChain, register),
          hashRotateOwnerIntentV1(otherChain, rotate),
          hashRevokeDeviceIntentV1(otherChain, revoke),
        ]),
        Effect.all([
          hashRegisterIntentV1(otherRegistry, register),
          hashRotateOwnerIntentV1(otherRegistry, rotate),
          hashRevokeDeviceIntentV1(otherRegistry, revoke),
        ]),
      ]);

      for (const index of [0, 1, 2]) {
        assert.notStrictEqual(baseDigests[index], chainDigests[index]);
        assert.notStrictEqual(baseDigests[index], registryDigests[index]);
        assert.notStrictEqual(chainDigests[index], registryDigests[index]);
      }
    })
  );

  it.effect("pins handle and excess-property policy failures", () =>
    Effect.gen(function* () {
      const uppercaseError = yield* decodeRegisterIntentV1({
        ...encodedRegisterIntent,
        handle: "Alice",
      }).pipe(Effect.flip);
      assert.deepStrictEqual(formatIssue(uppercaseError.issue).issues, [
        {
          message: "Expected a handle containing only lowercase ASCII letters",
          path: ["handle"],
        },
      ]);

      const excessError = yield* decodeRegisterIntentV1({
        ...encodedRegisterIntent,
        unexpected: true,
      }).pipe(Effect.flip);
      assert.deepStrictEqual(formatIssue(excessError.issue).issues, [
        {
          message: "Unexpected registration intent field",
          path: ["unexpected"],
        },
      ]);

      const rotateExcessError = yield* decodeRotateOwnerIntentV1({
        ...encodedRotateOwnerIntent,
        unexpected: true,
      }).pipe(Effect.flip);
      assert.deepStrictEqual(formatIssue(rotateExcessError.issue).issues, [
        {
          message: "Unexpected owner rotation intent field",
          path: ["unexpected"],
        },
      ]);

      const revokeExcessError = yield* decodeRevokeDeviceIntentV1({
        ...encodedRevokeDeviceIntent,
        unexpected: true,
      }).pipe(Effect.flip);
      assert.deepStrictEqual(formatIssue(revokeExcessError.issue).issues, [
        {
          message: "Unexpected device revocation intent field",
          path: ["unexpected"],
        },
      ]);

      const oversizedNonce = yield* decodeRotateOwnerIntentV1({
        ...encodedRotateOwnerIntent,
        nonce: (2n ** 256n).toString(),
      }).pipe(Effect.flip);
      assert.deepStrictEqual(formatIssue(oversizedNonce.issue).issues, [
        {
          message: "Expected a uint256",
          path: ["nonce"],
        },
      ]);

      const zeroRegistrationNonce = yield* decodeRegisterIntentV1({
        ...encodedRegisterIntent,
        nonce: `0x${"00".repeat(32)}`,
      }).pipe(Effect.flip);
      assert.deepStrictEqual(formatIssue(zeroRegistrationNonce.issue).issues, [
        {
          message: "Expected a non-zero registration nonce",
          path: ["nonce"],
        },
      ]);

      const zeroDeviceCommitment = yield* decodeRegisterIntentV1({
        ...encodedRegisterIntent,
        deviceCommitment: `0x${"00".repeat(32)}`,
      }).pipe(Effect.flip);
      assert.deepStrictEqual(formatIssue(zeroDeviceCommitment.issue).issues, [
        {
          message: "Expected a non-zero device commitment",
          path: ["deviceCommitment"],
        },
      ]);

      const zeroCertificateDigest = yield* decodeRevokeDeviceIntentV1({
        ...encodedRevokeDeviceIntent,
        certificateDigest: `0x${"00".repeat(32)}`,
      }).pipe(Effect.flip);
      assert.deepStrictEqual(formatIssue(zeroCertificateDigest.issue).issues, [
        {
          message: "Expected a non-zero certificate digest",
          path: ["certificateDigest"],
        },
      ]);

      const zeroOwner = "0x0000000000000000000000000000000000000000";
      const zeroRegisterOwner = yield* decodeRegisterIntentV1({
        ...encodedRegisterIntent,
        owner: zeroOwner,
      }).pipe(Effect.flip);
      assert.deepStrictEqual(formatIssue(zeroRegisterOwner.issue).issues, [
        {
          message: "Expected a non-zero Ethereum address",
          path: ["owner"],
        },
      ]);

      const zeroRotationOwner = yield* decodeRotateOwnerIntentV1({
        ...encodedRotateOwnerIntent,
        newOwner: zeroOwner,
      }).pipe(Effect.flip);
      assert.deepStrictEqual(formatIssue(zeroRotationOwner.issue).issues, [
        {
          message: "Expected a non-zero Ethereum address",
          path: ["newOwner"],
        },
      ]);
    })
  );
});
