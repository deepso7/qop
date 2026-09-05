import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema, SchemaIssue } from "effect";

import {
  decodeIdentityEip712DomainV1,
  IdentityEip712DomainV1,
} from "../src/index.ts";

const encodedDomain = {
  chainId: "11155111",
  verifyingContract: "0x1111111111111111111111111111111111111111",
} as const;

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();
type Json = typeof Schema.Json.Type;

const expectDomainIssue = Effect.fn("@qop/identity/test/expectDomainIssue")(
  function* (input: Json, path: readonly string[], message: string) {
    const error = yield* Schema.decodeUnknownEffect(IdentityEip712DomainV1)(
      input
    ).pipe(Effect.flip);
    assert.deepStrictEqual(formatIssue(error.issue).issues, [
      { message, path },
    ]);
  }
);

describe("identity EIP-712", () => {
  it.effect("decodes the canonical domain", () =>
    Effect.gen(function* () {
      const domain = yield* decodeIdentityEip712DomainV1(encodedDomain);
      assert.deepStrictEqual(domain, {
        chainId: 11_155_111n,
        verifyingContract: encodedDomain.verifyingContract,
      });
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
