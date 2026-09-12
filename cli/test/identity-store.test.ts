import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { createCliIdentityStore } from "../src/identity-store.ts";

describe("CLI identity store", () => {
  it.effect("persists a pending key before a second process can lock", () =>
    Effect.gen(function* () {
      const root = yield* Effect.tryPromise(() =>
        mkdtemp(path.join(tmpdir(), "qop-cli-"))
      );
      const store = createCliIdentityStore(root);
      const lock = yield* store.acquireLock();
      const identity = yield* store.createPendingKey({
        account: "alice",
        chainId: "31337",
        handle: "alice",
        qid: "42",
        registry: "0x1111111111111111111111111111111111111111",
      });
      const loaded = yield* store.loadIdentity();
      expect(loaded?.deviceKey).toBe(identity.deviceKey);
      expect(loaded?.peerId).toBe(identity.peerId);
      const again = yield* store.createPendingKey({
        account: "alice",
        chainId: "31337",
        handle: "alice",
        qid: "42",
        registry: "0x1111111111111111111111111111111111111111",
      });
      expect(again.deviceKey).toBe(identity.deviceKey);
      const conflicting = yield* createCliIdentityStore(root)
        .acquireLock()
        .pipe(Effect.result);
      expect(conflicting._tag).toBe("Failure");
      yield* lock.release;
      yield* Effect.tryPromise(() =>
        rm(root, { force: true, recursive: true })
      );
    })
  );
});
