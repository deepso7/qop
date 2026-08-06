import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema, SchemaIssue } from "effect";
import { privateKeyToAccount } from "viem/accounts";

import {
  decodeDeviceCertificateV1,
  decodeIdentityEip712DomainV1,
  EcdsaSignature,
  hashDeviceCertificateV1,
  makeDeviceCertificateTypedDataV1,
  normalizeEcdsaSignature,
  recoverDeviceCertificateOwnerV1,
  verifyDeviceCertificateOwnerV1,
} from "../src/index.ts";

const PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
const EXPECTED_OWNER = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const EXPECTED_DIGEST =
  "0x0fe41d712ec3ec99c4f62ed1b97c04ec30bd56985f9cf698d3c554db062119bd";

const encodedCertificate = {
  encryptionPublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  issuedAt: "1700000000",
  ownerVersion: 3,
  peerId: "12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X",
  qid: "42",
  salt: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
  version: 1,
} as const;

const encodedDomain = {
  chainId: "11155111",
  verifyingContract: "0x1111111111111111111111111111111111111111",
} as const;

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

const expectDomainIssue = Effect.fn("@qop/identity/test/expectDomainIssue")(
  function* (input: unknown, path: readonly string[], message: string) {
    const error = yield* decodeIdentityEip712DomainV1(input).pipe(Effect.flip);
    assert.deepStrictEqual(formatIssue(error.issue).issues, [
      { message, path },
    ]);
  }
);

describe("identity EIP-712", () => {
  it.effect("pins the certificate typed-data digest", () =>
    Effect.gen(function* () {
      const certificate = yield* decodeDeviceCertificateV1(encodedCertificate);
      const domain = yield* decodeIdentityEip712DomainV1(encodedDomain);
      const digest = yield* hashDeviceCertificateV1(domain, certificate);

      assert.strictEqual(digest, EXPECTED_DIGEST);
      assert.deepStrictEqual(
        makeDeviceCertificateTypedDataV1(domain, certificate),
        {
          domain: {
            chainId: 11_155_111n,
            name: "QOP Identity",
            verifyingContract: encodedDomain.verifyingContract,
            version: "1",
          },
          message: {
            encryptionPublicKey:
              "0x0000000000000000000000000000000000000000000000000000000000000000",
            issuedAt: 1_700_000_000n,
            ownerVersion: 3,
            peerId:
              "0x002408011220cecc1507dc1ddd7295951c290888f095adb9044d1b73d696e6df065d683bd4fc",
            qid: 42n,
            salt: "0x0101010101010101010101010101010101010101010101010101010101010101",
            version: 1,
          },
          primaryType: "DeviceCertificateV1",
          types: {
            DeviceCertificateV1: [
              { name: "version", type: "uint8" },
              { name: "qid", type: "uint256" },
              { name: "ownerVersion", type: "uint32" },
              { name: "peerId", type: "bytes" },
              { name: "encryptionPublicKey", type: "bytes32" },
              { name: "issuedAt", type: "uint64" },
              { name: "salt", type: "bytes32" },
            ],
          },
        }
      );
    })
  );

  it.effect("normalizes wallet v and recovers the certificate owner", () =>
    Effect.gen(function* () {
      const account = privateKeyToAccount(PRIVATE_KEY);
      const certificate = yield* decodeDeviceCertificateV1(encodedCertificate);
      const domain = yield* decodeIdentityEip712DomainV1(encodedDomain);
      const walletSignature = yield* Effect.promise(() =>
        account.signTypedData(
          makeDeviceCertificateTypedDataV1(domain, certificate)
        )
      );

      assert.include(["1b", "1c"], walletSignature.slice(-2));

      const signature = yield* normalizeEcdsaSignature(walletSignature);
      assert.include([0, 1], signature[64]);
      assert.strictEqual(
        (yield* Schema.encodeEffect(EcdsaSignature)(signature)).slice(-2),
        signature[64]?.toString().padStart(2, "0")
      );

      const recovered = yield* recoverDeviceCertificateOwnerV1(
        domain,
        certificate,
        signature
      );
      assert.strictEqual(recovered, EXPECTED_OWNER);
      assert.isTrue(
        yield* verifyDeviceCertificateOwnerV1(
          domain,
          certificate,
          signature,
          recovered
        )
      );
      assert.isTrue(
        yield* verifyDeviceCertificateOwnerV1(
          domain,
          certificate,
          signature,
          account.address
        )
      );
      assert.isFalse(
        yield* verifyDeviceCertificateOwnerV1(
          domain,
          { ...certificate, ownerVersion: certificate.ownerVersion + 1 },
          signature,
          account.address
        )
      );

      const invalidOwnerError = yield* verifyDeviceCertificateOwnerV1(
        domain,
        certificate,
        signature,
        "not-an-address"
      ).pipe(Effect.flip);
      assert.strictEqual(
        invalidOwnerError.operation,
        "verify-certificate-owner"
      );
    })
  );

  it.effect("separates certificate digests by chain and registry", () =>
    Effect.gen(function* () {
      const certificate = yield* decodeDeviceCertificateV1(encodedCertificate);
      const domain = yield* decodeIdentityEip712DomainV1(encodedDomain);
      const otherChain = yield* decodeIdentityEip712DomainV1({
        ...encodedDomain,
        chainId: "1",
      });
      const otherRegistry = yield* decodeIdentityEip712DomainV1({
        ...encodedDomain,
        verifyingContract: "0x2222222222222222222222222222222222222222",
      });

      const [digest, chainDigest, registryDigest] = yield* Effect.all([
        hashDeviceCertificateV1(domain, certificate),
        hashDeviceCertificateV1(otherChain, certificate),
        hashDeviceCertificateV1(otherRegistry, certificate),
      ]);

      assert.notStrictEqual(digest, chainDigest);
      assert.notStrictEqual(digest, registryDigest);
      assert.notStrictEqual(chainDigest, registryDigest);
    })
  );

  it.effect("keeps the domain wire schema canonical and strict", () =>
    Effect.gen(function* () {
      yield* expectDomainIssue(
        { ...encodedDomain, chainId: "0" },
        ["chainId"],
        "Expected a positive uint256 chain id"
      );
      yield* expectDomainIssue(
        { ...encodedDomain, chainId: "01" },
        ["chainId"],
        "Expected a canonical uint256 decimal string"
      );
      yield* expectDomainIssue(
        {
          ...encodedDomain,
          verifyingContract: "0x111111111111111111111111111111111111111A",
        },
        ["verifyingContract"],
        "Expected a canonical lowercase Ethereum address"
      );
      yield* expectDomainIssue(
        { ...encodedDomain, unexpected: true },
        ["unexpected"],
        "Unexpected identity EIP-712 domain field"
      );
    })
  );
});
