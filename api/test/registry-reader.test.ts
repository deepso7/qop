import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import type { Address, Hash } from "viem";

import { RegistryChain } from "../src/registry/chain.ts";
import type { RegistryChainShape } from "../src/registry/chain.ts";
import { RegistryReader } from "../src/registry/reader.ts";
import type { RegistryAccount } from "../src/registry/types.ts";

const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const CERTIFICATE_DIGEST =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hash;
const MIXED_CASE_CERTIFICATE_DIGEST =
  "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa" as Hash;
const CANONICAL_OWNER = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as Address;
const MIXED_CASE_OWNER =
  "0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd" as Address;

const account = (owner = OWNER): RegistryAccount => ({
  handle: "alice",
  nonce: 0n,
  owner,
  ownerVersion: 0,
  qid: 1n,
  registeredAt: 1_700_000_000n,
});

const makeReader = () => {
  let accountValue = account();
  let handleQid: bigint | null = 1n;
  let ownerQid: bigint | null = 1n;
  let revoked = false;
  const calls = {
    account: 0,
    deviceRevocation: 0,
    qidByHandle: 0,
    qidByOwner: 0,
  };
  const observed = {
    certificateDigests: [] as Hash[],
    handles: [] as string[],
    owners: [] as Address[],
  };
  const chain: RegistryChainShape = {
    account: (qid) =>
      Effect.sync(() => {
        calls.account += 1;
        return {
          blockNumber: BigInt(calls.account),
          value: { ...accountValue, qid },
        };
      }),
    deviceRevocation: (_qid, certificateDigest) =>
      Effect.sync(() => {
        calls.deviceRevocation += 1;
        observed.certificateDigests.push(certificateDigest);
        return {
          blockNumber: BigInt(calls.deviceRevocation),
          value: revoked,
        };
      }),
    qidByHandle: (handle) =>
      Effect.sync(() => {
        calls.qidByHandle += 1;
        observed.handles.push(handle);
        return { blockNumber: 1n, value: handleQid };
      }),
    qidByOwner: (owner) =>
      Effect.sync(() => {
        calls.qidByOwner += 1;
        observed.owners.push(owner);
        return { blockNumber: 1n, value: ownerQid };
      }),
    registrationProbe: () =>
      Effect.succeed({
        blockNumber: 1n,
        value: {
          blockTimestamp: 1_700_000_000n,
          handleQid,
          ownerQid,
          registrationNonceUsed: false,
        },
      }),
  };
  const layer = RegistryReader.layer.pipe(
    Layer.provide(Layer.succeed(RegistryChain, RegistryChain.of(chain)))
  );

  return {
    calls,
    layer,
    observed,
    revoke: () => {
      revoked = true;
    },
    rotate: (owner: Address) => {
      accountValue = { ...accountValue, owner, ownerVersion: 1 };
    },
    setHandleQid: (qid: bigint | null) => {
      handleQid = qid;
    },
    setOwnerQid: (qid: bigint | null) => {
      ownerQid = qid;
    },
  };
};

describe("registry reader", () => {
  it.effect("distinguishes cached reads from explicit fresh reads", () => {
    const fixture = makeReader();
    const nextOwner = "0x2222222222222222222222222222222222222222" as Address;

    return Effect.gen(function* () {
      const reader = yield* RegistryReader;
      const first = yield* reader.cached.account(1n);
      fixture.rotate(nextOwner);
      const cached = yield* reader.cached.account(1n);
      const fresh = yield* reader.fresh.account(1n);

      assert.strictEqual(first.value.owner, OWNER);
      assert.strictEqual(cached.value.owner, OWNER);
      assert.strictEqual(fresh.value.owner, nextOwner);
      assert.strictEqual(fresh.blockNumber, 2n);
      assert.strictEqual(fixture.calls.account, 2);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("refreshes a stale negative revocation result", () => {
    const fixture = makeReader();

    return Effect.gen(function* () {
      const reader = yield* RegistryReader;
      const first = yield* reader.cached.deviceRevocation(
        1n,
        CERTIFICATE_DIGEST
      );
      fixture.revoke();
      yield* TestClock.adjust(Duration.seconds(16));
      const stale = yield* reader.cached.deviceRevocation(
        1n,
        CERTIFICATE_DIGEST
      );
      yield* Effect.yieldNow;
      const refreshed = yield* reader.cached.deviceRevocation(
        1n,
        CERTIFICATE_DIGEST
      );

      assert.isFalse(first.value);
      assert.isFalse(stale.value);
      assert.strictEqual(stale.freshness, "stale");
      assert.isTrue(refreshed.value);
      assert.strictEqual(refreshed.blockNumber, 2n);
      assert.strictEqual(fixture.calls.deviceRevocation, 2);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("keeps a confirmed revocation in the long-lived cache", () => {
    const fixture = makeReader();
    fixture.revoke();

    return Effect.gen(function* () {
      const reader = yield* RegistryReader;
      assert.isTrue(
        (yield* reader.cached.deviceRevocation(1n, CERTIFICATE_DIGEST)).value
      );
      yield* TestClock.adjust(Duration.hours(12));
      assert.isTrue(
        (yield* reader.cached.deviceRevocation(1n, CERTIFICATE_DIGEST)).value
      );
      assert.strictEqual(fixture.calls.deviceRevocation, 1);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("canonicalizes owner and certificate-digest cache keys", () => {
    const fixture = makeReader();

    return Effect.gen(function* () {
      const reader = yield* RegistryReader;
      yield* reader.cached.qidByOwner(MIXED_CASE_OWNER);
      yield* reader.cached.qidByOwner(CANONICAL_OWNER);
      yield* reader.cached.deviceRevocation(1n, MIXED_CASE_CERTIFICATE_DIGEST);
      yield* reader.cached.deviceRevocation(1n, CERTIFICATE_DIGEST);

      assert.strictEqual(fixture.calls.qidByOwner, 1);
      assert.strictEqual(fixture.calls.deviceRevocation, 1);
      assert.deepStrictEqual(fixture.observed.owners, [CANONICAL_OWNER]);
      assert.deepStrictEqual(fixture.observed.certificateDigests, [
        CERTIFICATE_DIGEST,
      ]);

      yield* reader.invalidate.qidByOwner(MIXED_CASE_OWNER);
      yield* reader.invalidate.deviceRevocation(
        1n,
        MIXED_CASE_CERTIFICATE_DIGEST
      );
      yield* reader.cached.qidByOwner(CANONICAL_OWNER);
      yield* reader.cached.deviceRevocation(1n, CERTIFICATE_DIGEST);
      assert.strictEqual(fixture.calls.qidByOwner, 2);
      assert.strictEqual(fixture.calls.deviceRevocation, 2);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("invalidates account and owner mappings after rotation", () => {
    const fixture = makeReader();
    const nextOwner = "0x2222222222222222222222222222222222222222" as Address;

    return Effect.gen(function* () {
      const reader = yield* RegistryReader;
      yield* reader.cached.account(1n);
      yield* reader.cached.qidByOwner(OWNER);
      yield* reader.cached.qidByOwner(nextOwner);

      yield* reader.invalidate.ownerRotation(1n, OWNER, nextOwner);
      yield* reader.cached.account(1n);
      yield* reader.cached.qidByOwner(OWNER);
      yield* reader.cached.qidByOwner(nextOwner);

      assert.strictEqual(fixture.calls.account, 2);
      assert.strictEqual(fixture.calls.qidByOwner, 4);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect(
    "refreshes handle misses but keeps confirmed hits long-lived",
    () => {
      const missFixture = makeReader();
      missFixture.setHandleQid(null);
      const hitFixture = makeReader();

      const missProgram = Effect.gen(function* () {
        const reader = yield* RegistryReader;
        assert.isNull((yield* reader.cached.qidByHandle("alice")).value);
        missFixture.setHandleQid(1n);
        yield* TestClock.adjust(Duration.seconds(11));
        const stale = yield* reader.cached.qidByHandle("alice");
        assert.isNull(stale.value);
        assert.strictEqual(stale.freshness, "stale");
        yield* Effect.yieldNow;
        assert.strictEqual(
          (yield* reader.cached.qidByHandle("alice")).value,
          1n
        );
        assert.strictEqual(missFixture.calls.qidByHandle, 2);
      }).pipe(Effect.provide(missFixture.layer));

      const hitProgram = Effect.gen(function* () {
        const reader = yield* RegistryReader;
        assert.strictEqual(
          (yield* reader.cached.qidByHandle("alice")).value,
          1n
        );
        hitFixture.setHandleQid(null);
        yield* TestClock.adjust(Duration.hours(12));
        assert.strictEqual(
          (yield* reader.cached.qidByHandle("alice")).value,
          1n
        );
        assert.strictEqual(hitFixture.calls.qidByHandle, 1);
      }).pipe(Effect.provide(hitFixture.layer));

      return Effect.all([missProgram, hitProgram], { discard: true });
    }
  );

  it.effect("rejects invalid handles before entering the cache", () => {
    const fixture = makeReader();

    return Effect.gen(function* () {
      const reader = yield* RegistryReader;
      const failure = yield* reader.cached
        .qidByHandle("A".repeat(10_000))
        .pipe(Effect.flip);

      assert.strictEqual(failure._tag, "RegistryInputError");
      assert.strictEqual(failure.operation, "handle");
      assert.strictEqual(fixture.calls.qidByHandle, 0);
    }).pipe(Effect.provide(fixture.layer));
  });
});
