import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { createCliIdentityStore } from "../src/identity-store.ts";

const publicIdentity = {
  account: "alice",
  chainId: "31337",
  handle: "alice",
  qid: "42",
  registry: "0x1111111111111111111111111111111111111111",
};

describe("CLI identity store", () => {
  it.effect("persists a pending key before a second process can lock", () =>
    Effect.gen(function* () {
      const root = yield* Effect.tryPromise(() =>
        mkdtemp(path.join(tmpdir(), "qop-cli-"))
      );
      const store = createCliIdentityStore(root);
      const lock = yield* store.acquireLock();
      const identity = yield* store.createPendingKey(publicIdentity);
      const loaded = yield* store.loadIdentity();
      expect(loaded?.deviceKey).toBe(identity.deviceKey);
      expect(loaded?.peerId).toBe(identity.peerId);
      const again = yield* store.createPendingKey(publicIdentity);
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

  it.effect(
    "fails closed on corrupt identity instead of minting a new key",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.tryPromise(() =>
          mkdtemp(path.join(tmpdir(), "qop-cli-"))
        );
        const store = createCliIdentityStore(root);
        const lock = yield* store.acquireLock();
        const identityPath = path.join(root, "identity.json");
        yield* Effect.tryPromise(() =>
          writeFile(identityPath, "{not-json", { mode: 0o600 })
        );
        yield* Effect.tryPromise(() => chmod(identityPath, 0o600));
        const minted = yield* store
          .createPendingKey(publicIdentity)
          .pipe(Effect.result);
        expect(minted._tag).toBe("Failure");
        if (minted._tag === "Failure") {
          expect(minted.failure.operation).toBe("decode");
        }
        yield* lock.release;
        yield* Effect.tryPromise(() =>
          rm(root, { force: true, recursive: true })
        );
      })
  );

  it.effect("does not overwrite a secret when identity.json is missing", () =>
    Effect.gen(function* () {
      const root = yield* Effect.tryPromise(() =>
        mkdtemp(path.join(tmpdir(), "qop-cli-"))
      );
      const store = createCliIdentityStore(root);
      const lock = yield* store.acquireLock();
      const secretPath = path.join(root, "device.key");
      const secret = Buffer.from("a".repeat(32));
      yield* Effect.tryPromise(() =>
        writeFile(secretPath, secret, { mode: 0o600 })
      );
      yield* Effect.tryPromise(() => chmod(secretPath, 0o600));
      const minted = yield* store
        .createPendingKey(publicIdentity)
        .pipe(Effect.result);
      expect(minted._tag).toBe("Failure");
      if (minted._tag === "Failure") {
        expect(minted.failure.operation).toBe("conflict");
      }
      const leftover = yield* Effect.tryPromise(() => readFile(secretPath));
      expect(Buffer.from(leftover).equals(secret)).toBe(true);
      yield* lock.release;
      yield* Effect.tryPromise(() =>
        rm(root, { force: true, recursive: true })
      );
    })
  );
});
