import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

  it.effect("recovers a dead-pid lock without admitting two writers", () =>
    Effect.gen(function* () {
      const root = yield* Effect.tryPromise(() =>
        mkdtemp(path.join(tmpdir(), "qop-cli-"))
      );
      const lockPath = path.join(root, "lock");
      yield* Effect.tryPromise(() =>
        writeFile(lockPath, "2147483647\n", { mode: 0o600 })
      );
      yield* Effect.tryPromise(() => chmod(lockPath, 0o600));
      yield* Effect.tryPromise(() => chmod(root, 0o700));
      const results = yield* Effect.all(
        [
          createCliIdentityStore(root).acquireLock().pipe(Effect.result),
          createCliIdentityStore(root).acquireLock().pipe(Effect.result),
        ],
        { concurrency: "unbounded" }
      );
      const successes = results.filter((result) => result._tag === "Success");
      expect(successes.length).toBe(1);
      if (successes[0]?._tag === "Success") {
        yield* successes[0].success.release;
      }
      yield* Effect.tryPromise(() =>
        rm(root, { force: true, recursive: true })
      );
    })
  );

  it.effect("does not steal an exclusive lock that has no PID yet", () =>
    Effect.gen(function* () {
      const root = yield* Effect.tryPromise(() =>
        mkdtemp(path.join(tmpdir(), "qop-cli-"))
      );
      const lockPath = path.join(root, "lock");
      yield* Effect.tryPromise(() =>
        writeFile(lockPath, "", { flag: "wx", mode: 0o600 })
      );
      yield* Effect.tryPromise(() => chmod(lockPath, 0o600));
      yield* Effect.tryPromise(() => chmod(root, 0o700));
      const stolen = yield* createCliIdentityStore(root)
        .acquireLock()
        .pipe(Effect.result);
      expect(stolen._tag).toBe("Failure");
      if (stolen._tag === "Failure") {
        expect(stolen.failure.operation).toBe("conflict");
      }
      yield* Effect.tryPromise(() =>
        rm(root, { force: true, recursive: true })
      );
    })
  );

  it.effect(
    "admits only one writer when two processes race stale-lock recovery",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.tryPromise(() =>
          mkdtemp(path.join(tmpdir(), "qop-cli-"))
        );
        const lockPath = path.join(root, "lock");
        yield* Effect.tryPromise(() =>
          writeFile(lockPath, "2147483647\n", { mode: 0o600 })
        );
        yield* Effect.tryPromise(() => chmod(lockPath, 0o600));
        yield* Effect.tryPromise(() => chmod(root, 0o700));
        const worker = fileURLToPath(
          new URL("lock-recover-worker.ts", import.meta.url)
        );
        const spawnRecoverer = () =>
          Effect.callback<
            { child: ReturnType<typeof spawn>; output: string },
            Error
          >((resume) => {
            const child = spawn(
              process.execPath,
              ["--experimental-strip-types", worker, root, "200"],
              {
                cwd: fileURLToPath(new URL("..", import.meta.url)),
                stdio: ["ignore", "pipe", "pipe"],
              }
            );
            let output = "";
            let settled = false;
            const finish = (
              effect: Effect.Effect<
                { child: ReturnType<typeof spawn>; output: string },
                Error
              >
            ) => {
              if (settled) {
                return;
              }
              settled = true;
              resume(effect);
            };
            child.stdout?.on("data", (chunk: Buffer | string) => {
              output += chunk.toString();
              if (/SUCCESS|FAILURE/u.test(output)) {
                finish(Effect.succeed({ child, output }));
              }
            });
            child.stderr?.on("data", (chunk: Buffer | string) => {
              output += chunk.toString();
            });
            child.once("error", (error: Error) => {
              finish(Effect.fail(error));
            });
            child.once("exit", (code) => {
              if (/SUCCESS|FAILURE/u.test(output)) {
                finish(Effect.succeed({ child, output }));
                return;
              }
              finish(
                Effect.fail(new Error(`worker exited ${code}: ${output}`))
              );
            });
          });
        const [first, second] = yield* Effect.all(
          [spawnRecoverer(), spawnRecoverer()],
          { concurrency: "unbounded" }
        );
        const lines = `${first.output}\n${second.output}`;
        const successes = (lines.match(/SUCCESS/gu) ?? []).length;
        const failures = (lines.match(/FAILURE/gu) ?? []).length;
        expect(successes).toBe(1);
        expect(failures).toBe(1);
        first.child.kill("SIGTERM");
        second.child.kill("SIGTERM");
        yield* Effect.tryPromise(() =>
          rm(root, { force: true, recursive: true })
        );
      })
  );
});
