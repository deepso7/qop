import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import type { Address } from "viem";

import { RegistryChain } from "../src/registry/chain.ts";
import type { RegistryChainContract } from "../src/registry/chain.ts";
import { RegistryReader } from "../src/registry/reader.ts";
import type { RegistryAccount } from "../src/registry/types.ts";
import { testHash } from "./support/ethereum.ts";

const OWNER = "0x1111111111111111111111111111111111111111" satisfies Address;
const NEXT_OWNER =
  "0x2222222222222222222222222222222222222222" satisfies Address;

const account = (owner: Address = OWNER): RegistryAccount => ({
  devices: [testHash("device")],
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
  const calls = { account: 0, qidByHandle: 0, qidByOwner: 0 };
  const chain: RegistryChainContract = {
    account: (qid) =>
      Effect.sync(() => {
        calls.account += 1;
        return {
          blockNumber: BigInt(calls.account),
          value: { ...accountValue, qid },
        };
      }),
    qidByHandle: () =>
      Effect.sync(() => {
        calls.qidByHandle += 1;
        return { blockNumber: 1n, value: handleQid };
      }),
    qidByOwner: () =>
      Effect.sync(() => {
        calls.qidByOwner += 1;
        return { blockNumber: 1n, value: 1n };
      }),
    registrationProbe: () =>
      Effect.succeed({
        blockNumber: 1n,
        value: {
          blockTimestamp: 1_700_000_000n,
          handleQid,
          ownerQid: 1n,
          registrationNonceUsed: false,
        },
      }),
  };
  return {
    calls,
    layer: RegistryReader.layer.pipe(
      Layer.provide(Layer.succeed(RegistryChain, RegistryChain.of(chain)))
    ),
    rotate: () => {
      accountValue = { ...accountValue, owner: NEXT_OWNER, ownerVersion: 1 };
    },
    setHandleQid: (qid: bigint | null) => {
      handleQid = qid;
    },
  };
};

describe("registry reader", () => {
  it.effect(
    "returns the device roster and distinguishes cached from fresh reads",
    () => {
      const fixture = makeReader();
      return Effect.gen(function* () {
        const reader = yield* RegistryReader;
        const first = yield* reader.cached.account(1n);
        fixture.rotate();
        const cached = yield* reader.cached.account(1n);
        const fresh = yield* reader.fresh.account(1n);

        assert.deepStrictEqual(first.value.devices, [testHash("device")]);
        assert.strictEqual(cached.value.owner, OWNER);
        assert.strictEqual(fresh.value.owner, NEXT_OWNER);
        assert.strictEqual(fixture.calls.account, 2);
      }).pipe(Effect.provide(fixture.layer));
    }
  );

  it.effect("refreshes handle misses", () => {
    const fixture = makeReader();
    fixture.setHandleQid(null);
    return Effect.gen(function* () {
      const reader = yield* RegistryReader;
      assert.isNull((yield* reader.cached.qidByHandle("alice")).value);
      fixture.setHandleQid(1n);
      yield* TestClock.adjust(Duration.seconds(11));
      assert.strictEqual(
        (yield* reader.cached.qidByHandle("alice")).freshness,
        "stale"
      );
      yield* Effect.yieldNow;
      assert.strictEqual((yield* reader.cached.qidByHandle("alice")).value, 1n);
      assert.strictEqual(fixture.calls.qidByHandle, 2);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect(
    "invalidates account and owner mappings after owner rotation",
    () => {
      const fixture = makeReader();
      return Effect.gen(function* () {
        const reader = yield* RegistryReader;
        yield* reader.cached.account(1n);
        yield* reader.cached.qidByOwner(OWNER);
        yield* reader.cached.qidByOwner(NEXT_OWNER);
        yield* reader.invalidate.ownerRotation(1n, OWNER, NEXT_OWNER);
        yield* reader.cached.account(1n);
        yield* reader.cached.qidByOwner(OWNER);
        yield* reader.cached.qidByOwner(NEXT_OWNER);

        assert.strictEqual(fixture.calls.account, 2);
        assert.strictEqual(fixture.calls.qidByOwner, 4);
      }).pipe(Effect.provide(fixture.layer));
    }
  );
});
