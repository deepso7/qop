import { assert, layer } from "@effect/vitest";
import { DateTime, Effect, Layer } from "effect";

import {
  DeviceActionInFlightConflict,
  DeviceActionStore,
} from "../src/device-action/store.ts";
import type { CreateDeviceActionIntent } from "../src/device-action/types.ts";
import { testAddress, testHash, testSignature } from "./support/ethereum.ts";
import { TestDatabaseLive } from "./support/registration-database.ts";

const signature = testSignature("1B");
const owner = testAddress("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");

const deadlineAfter = Effect.fn("test.deadlineAfter")(function* (
  seconds: number
) {
  const now = yield* DateTime.now;
  return BigInt(Math.floor(DateTime.toEpochMillis(now) / 1000) + seconds);
});

const deviceInput = (
  id: number,
  deadline: bigint,
  qid = 42n
): CreateDeviceActionIntent => ({
  accountNonce: BigInt(id),
  deadline,
  deviceKey: testHash(40_000 + id),
  digest: testHash(10_000 + id),
  operation: "add",
  owner,
  ownerSignature: signature,
  qid,
});

const StoreTestLive = DeviceActionStore.layer.pipe(
  Layer.provideMerge(TestDatabaseLive)
);

layer(StoreTestLive, { timeout: "30 seconds" })((it) => {
  it.effect("creates a ready device action and replays the same digest", () =>
    Effect.gen(function* () {
      const store = yield* DeviceActionStore;
      const input = deviceInput(1, yield* deadlineAfter(60));
      const created = yield* store.create(input);
      const replay = yield* store.create(input);

      assert.strictEqual(created.status, "ready");
      assert.strictEqual(created.digest, input.digest);
      assert.strictEqual(replay.digest, created.digest);
      assert.strictEqual(replay.status, "ready");
    })
  );

  it.effect("rejects a second in-flight digest for the same qid", () =>
    Effect.gen(function* () {
      const store = yield* DeviceActionStore;
      const deadline = yield* deadlineAfter(60);
      yield* store.create(deviceInput(2, deadline, 100n));
      const result = yield* store
        .create(deviceInput(3, deadline, 100n))
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

  it.effect("shares the relayer nonce allocator across device actions", () =>
    Effect.gen(function* () {
      const deviceActions = yield* DeviceActionStore;
      const deadline = yield* deadlineAfter(60);
      const first = yield* deviceActions.create(deviceInput(4, deadline, 200n));
      const submittedFirst = yield* deviceActions.prepareSubmission(
        first.digest,
        Effect.succeed(7n),
        (nonce) =>
          Effect.succeed({
            serializedTransaction: "0x02aa",
            transactionHash: testHash(`device-${nonce}`),
          })
      );
      assert.strictEqual(submittedFirst.transactionHash, testHash("device-7"));

      const second = yield* deviceActions.create(
        deviceInput(5, deadline, 201n)
      );
      const submittedSecond = yield* deviceActions.prepareSubmission(
        second.digest,
        Effect.succeed(0n),
        (nonce) =>
          Effect.succeed({
            serializedTransaction: "0x02bb",
            transactionHash: testHash(`device-${nonce}`),
          })
      );
      assert.strictEqual(submittedSecond.transactionHash, testHash("device-8"));
    })
  );
});
