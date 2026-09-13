import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";

import { createCliIdentityStore } from "../src/identity-store.ts";

const publicIdentity = {
  account: "alice",
  chainId: "31337",
  handle: "alice",
  qid: "42",
  registry: "0x1111111111111111111111111111111111111111",
};

const waitForPath = (filePath: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const found = yield* Effect.tryPromise(() =>
        readFile(filePath).then(
          () => true,
          () => false
        )
      );
      if (found) {
        return;
      }
      yield* Effect.sleep(25);
    }
    return yield* Effect.fail(new Error(`timed out waiting for ${filePath}`));
  });

interface RecovererOutput {
  child: ChildProcess;
  output: string;
}

const terminateWorker = (child: ChildProcess) =>
  Effect.callback<null>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.succeed(null));
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resume(Effect.succeed(null));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      finish();
    });
    if (child.exitCode !== null || child.signalCode !== null) {
      clearTimeout(timer);
      finish();
      return;
    }
    child.kill("SIGTERM");
  });

const startRecoverer = (root: string, worker: string, extra: string[] = []) =>
  Effect.gen(function* () {
    const state = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const child = spawn(
          process.execPath,
          ["--experimental-strip-types", worker, root, ...extra],
          {
            cwd: fileURLToPath(new URL("..", import.meta.url)),
            stdio: ["ignore", "pipe", "pipe"],
          }
        );
        const record = { child, output: "" };
        child.stdout?.on("data", (chunk: Buffer | string) => {
          record.output += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer | string) => {
          record.output += chunk.toString();
        });
        return record;
      }),
      ({ child }) => terminateWorker(child)
    );
    const outcome = Effect.callback<RecovererOutput, Error>((resume) => {
      let settled = false;
      const finish = (effect: Effect.Effect<RecovererOutput, Error>) => {
        if (settled) {
          return;
        }
        settled = true;
        resume(effect);
      };
      const succeedIfDone = () => {
        if (/SUCCESS|FAILURE/u.test(state.output)) {
          finish(Effect.succeed({ child: state.child, output: state.output }));
        }
      };
      succeedIfDone();
      state.child.stdout?.on("data", succeedIfDone);
      state.child.once("error", (error: Error) => {
        finish(Effect.fail(error));
      });
      state.child.once("exit", (code) => {
        succeedIfDone();
        if (!settled) {
          finish(
            Effect.fail(new Error(`worker exited ${code}: ${state.output}`))
          );
        }
      });
    });
    return { outcome, ...state };
  });

const spawnRecoverer = (root: string, worker: string, extra: string[] = []) =>
  Effect.gen(function* () {
    const started = yield* startRecoverer(root, worker, extra);
    return yield* started.outcome;
  });

const seedDeadLock = (root: string) =>
  Effect.gen(function* () {
    const lockPath = path.join(root, "lock");
    yield* Effect.tryPromise(() =>
      writeFile(lockPath, "2147483647\n", { mode: 0o600 })
    );
    yield* Effect.tryPromise(() => chmod(lockPath, 0o600));
    yield* Effect.tryPromise(() => chmod(root, 0o700));
    return lockPath;
  });

const seedDeadLockWithAbandonedClaim = (root: string) =>
  Effect.gen(function* () {
    const lockPath = yield* seedDeadLock(root);
    const info = yield* Effect.tryPromise(() => stat(lockPath));
    const claimPath = `${lockPath}.recover.${info.dev}.${info.ino}`;
    yield* Effect.tryPromise(() =>
      writeFile(claimPath, "2147483646\n", { mode: 0o600 })
    );
    yield* Effect.tryPromise(() => chmod(claimPath, 0o600));
    return { claimPath, lockPath };
  });

const withTempRoot = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(path.join(tmpdir(), "qop-cli-"))),
  (root) =>
    Effect.tryPromise({
      catch: () => new Error("cleanup failed"),
      try: () => rm(root, { force: true, recursive: true }),
    }).pipe(Effect.ignore)
);

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

  it.effect(
    "does not rename away a fresh lock acquired during stale recovery",
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
        const observed = yield* Deferred.make<boolean>();
        const releaseSlow = yield* Deferred.make<boolean>();
        const slow = createCliIdentityStore(root, {
          beforeRecoverSteal: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(observed, true);
              yield* Deferred.await(releaseSlow);
            }),
        });
        const slowFiber = yield* Effect.forkChild(
          slow.acquireLock().pipe(Effect.result)
        );
        yield* Deferred.await(observed);
        const fastResult = yield* createCliIdentityStore(root)
          .acquireLock()
          .pipe(Effect.result);
        yield* Deferred.succeed(releaseSlow, true);
        const slowResult = yield* Fiber.join(slowFiber);
        const successes = [fastResult, slowResult].filter(
          (result) => result._tag === "Success"
        );
        expect(successes.length).toBe(1);
        expect(fastResult._tag).toBe("Success");
        expect(slowResult._tag).toBe("Failure");
        if (fastResult._tag === "Success") {
          yield* fastResult.success.release;
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

  it.live(
    "admits only one writer when two processes race stale-lock recovery",
    () =>
      Effect.gen(function* () {
        const root = yield* withTempRoot;
        const observedPath = path.join(root, "observed");
        const releasePath = path.join(root, "release");
        yield* seedDeadLock(root);
        const worker = fileURLToPath(
          new URL("lock-recover-worker.ts", import.meta.url)
        );
        // Slow recoverer observes the dead lock, then waits. Fast recoverer
        // steals and wx in that window — the old rename-without-inode-check
        // would rename the fresh lock away and admit two writers.
        const slow = yield* startRecoverer(root, worker, [
          "0",
          observedPath,
          releasePath,
        ]);
        const slowFiber = yield* Effect.forkChild(slow.outcome);
        yield* waitForPath(observedPath);
        const fastResult = yield* spawnRecoverer(root, worker);
        yield* Effect.tryPromise(() => writeFile(releasePath, "go"));
        const slowResult = yield* Fiber.join(slowFiber);
        const lines = `${fastResult.output}\n${slowResult.output}`;
        const successes = (lines.match(/SUCCESS/gu) ?? []).length;
        const failures = (lines.match(/FAILURE/gu) ?? []).length;
        expect(successes).toBe(1);
        expect(failures).toBe(1);
        expect(fastResult.output).toContain("SUCCESS");
        expect(slowResult.output).toContain("FAILURE");
        expect(fastResult.child.exitCode).toBeNull();
      }),
    15_000
  );

  it.effect(
    "does not admit a third writer after recovery moves a live lock",
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
        const observed = yield* Deferred.make<boolean>();
        const releaseSlow = yield* Deferred.make<boolean>();
        const renamed = yield* Deferred.make<boolean>();
        const releaseAfterRename = yield* Deferred.make<boolean>();
        const slow = createCliIdentityStore(root, {
          afterRecoverRename: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(renamed, true);
              yield* Deferred.await(releaseAfterRename);
            }),
          beforeRecoverSteal: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(observed, true);
              yield* Deferred.await(releaseSlow);
            }),
        });
        const slowFiber = yield* Effect.forkChild(
          slow.acquireLock().pipe(Effect.result)
        );
        yield* Deferred.await(observed);
        const fastResult = yield* createCliIdentityStore(root)
          .acquireLock()
          .pipe(Effect.result);
        yield* Deferred.succeed(releaseSlow, true);
        const gap = yield* Effect.race(
          Deferred.await(renamed).pipe(Effect.as("renamed" as const)),
          Fiber.join(slowFiber).pipe(
            Effect.map((slowResult) => ({ slowResult }))
          )
        );
        const thirdResult = yield* createCliIdentityStore(root)
          .acquireLock()
          .pipe(Effect.result);
        const slowResult =
          gap === "renamed"
            ? yield* Effect.gen(function* () {
                yield* Deferred.succeed(releaseAfterRename, true);
                return yield* Fiber.join(slowFiber);
              })
            : gap.slowResult;
        const successes = [fastResult, slowResult, thirdResult].filter(
          (result) => result._tag === "Success"
        );
        expect(successes.length).toBe(1);
        expect(fastResult._tag).toBe("Success");
        expect(slowResult._tag).toBe("Failure");
        expect(thirdResult._tag).toBe("Failure");
        if (fastResult._tag === "Success") {
          yield* fastResult.success.release;
        }
        if (thirdResult._tag === "Success") {
          yield* thirdResult.success.release;
        }
        yield* Effect.tryPromise(() =>
          rm(root, { force: true, recursive: true })
        );
      })
  );

  it.live(
    "admits only one writer when three processes race stale-lock recovery",
    () =>
      Effect.gen(function* () {
        const root = yield* withTempRoot;
        const observedPath = path.join(root, "observed");
        const releasePath = path.join(root, "release");
        const renamedPath = path.join(root, "renamed");
        const releaseAfterRenamePath = path.join(root, "release-after-rename");
        yield* seedDeadLock(root);
        const worker = fileURLToPath(
          new URL("lock-recover-worker.ts", import.meta.url)
        );
        // Slow observes the dead lock and waits. Fast steals and holds. On the
        // old rename-without-claim path Slow then moves Fast's live lock, a
        // third process wx's the empty path, and restore fails — two writers.
        const slow = yield* startRecoverer(root, worker, [
          "0",
          observedPath,
          releasePath,
          renamedPath,
          releaseAfterRenamePath,
        ]);
        const slowFiber = yield* Effect.forkChild(slow.outcome);
        yield* waitForPath(observedPath);
        const fastResult = yield* spawnRecoverer(root, worker);
        yield* Effect.tryPromise(() => writeFile(releasePath, "go"));
        const gap = yield* Effect.race(
          waitForPath(renamedPath).pipe(Effect.as("renamed" as const)),
          Fiber.join(slowFiber).pipe(
            Effect.map((slowResult) => ({ slowResult }))
          )
        );
        const thirdResult = yield* spawnRecoverer(root, worker);
        const slowResult =
          gap === "renamed"
            ? yield* Effect.gen(function* () {
                yield* Effect.tryPromise(() =>
                  writeFile(releaseAfterRenamePath, "go")
                );
                return yield* Fiber.join(slowFiber);
              })
            : gap.slowResult;
        const lines = `${fastResult.output}\n${slowResult.output}\n${thirdResult.output}`;
        const successes = (lines.match(/SUCCESS/gu) ?? []).length;
        const failures = (lines.match(/FAILURE/gu) ?? []).length;
        expect(successes).toBe(1);
        expect(failures).toBe(2);
        expect(fastResult.output).toContain("SUCCESS");
        expect(slowResult.output).toContain("FAILURE");
        expect(thirdResult.output).toContain("FAILURE");
        expect(fastResult.child.exitCode).toBeNull();
      }),
    20_000
  );

  it.effect(
    "does not admit a writer while an abandoned recover-claim is left in place",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.tryPromise(() =>
          mkdtemp(path.join(tmpdir(), "qop-cli-"))
        );
        yield* seedDeadLockWithAbandonedClaim(root);
        const observedClaim = yield* Deferred.make<boolean>();
        const releaseSlow = yield* Deferred.make<boolean>();
        const slow = createCliIdentityStore(root, {
          afterExistingRecoverClaim: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(observedClaim, true);
              yield* Deferred.await(releaseSlow);
            }),
        });
        const slowFiber = yield* Effect.forkChild(
          slow.acquireLock().pipe(Effect.result)
        );
        yield* Deferred.await(observedClaim);
        // Restore-window interleaving: B has seen the leftover claim and has
        // not yet returned. A and C try to wx a replacement; D tries after B
        // backs off. Takeover-by-rename emptied the path here and admitted
        // two writers (A then D). Fail-closed keeps the path occupied.
        const fastResult = yield* createCliIdentityStore(root)
          .acquireLock()
          .pipe(Effect.result);
        const thirdResult = yield* createCliIdentityStore(root)
          .acquireLock()
          .pipe(Effect.result);
        yield* Deferred.succeed(releaseSlow, true);
        const slowResult = yield* Fiber.join(slowFiber);
        const fourthResult = yield* createCliIdentityStore(root)
          .acquireLock()
          .pipe(Effect.result);
        const successes = [
          fastResult,
          slowResult,
          thirdResult,
          fourthResult,
        ].filter((result) => result._tag === "Success");
        expect(successes.length).toBe(0);
        expect(fastResult._tag).toBe("Failure");
        expect(slowResult._tag).toBe("Failure");
        expect(thirdResult._tag).toBe("Failure");
        expect(fourthResult._tag).toBe("Failure");
        yield* Effect.tryPromise(() =>
          rm(root, { force: true, recursive: true })
        );
      })
  );

  it.effect(
    "recovers a dead lock after the operator removes the abandoned claim",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.tryPromise(() =>
          mkdtemp(path.join(tmpdir(), "qop-cli-"))
        );
        const { claimPath } = yield* seedDeadLockWithAbandonedClaim(root);
        const blocked = yield* createCliIdentityStore(root)
          .acquireLock()
          .pipe(Effect.result);
        expect(blocked._tag).toBe("Failure");
        yield* Effect.tryPromise(() => unlink(claimPath));
        const recovered = yield* createCliIdentityStore(root)
          .acquireLock()
          .pipe(Effect.result);
        expect(recovered._tag).toBe("Success");
        if (recovered._tag === "Success") {
          yield* recovered.success.release;
        }
        yield* Effect.tryPromise(() =>
          rm(root, { force: true, recursive: true })
        );
      })
  );

  it.live(
    "does not admit a writer when another recoverer enters during claim refusal",
    () =>
      Effect.gen(function* () {
        const root = yield* withTempRoot;
        const claimObservedPath = path.join(root, "claim-observed");
        const claimReleasePath = path.join(root, "claim-release");
        yield* seedDeadLockWithAbandonedClaim(root);
        const worker = fileURLToPath(
          new URL("lock-recover-worker.ts", import.meta.url)
        );
        // B sees the leftover claim and waits (old restore window). A and C
        // try to wx a replacement while the path is still occupied. Rename
        // takeover left that path empty so C could claim and later D could
        // steal A's live lock. Fail-closed: 0 writers until operator clear.
        const slow = yield* startRecoverer(root, worker, [
          "0",
          "",
          "",
          "",
          "",
          claimObservedPath,
          claimReleasePath,
        ]);
        const slowFiber = yield* Effect.forkChild(slow.outcome);
        yield* waitForPath(claimObservedPath);
        const fastResult = yield* spawnRecoverer(root, worker);
        const thirdResult = yield* spawnRecoverer(root, worker);
        yield* Effect.tryPromise(() => writeFile(claimReleasePath, "go"));
        const slowResult = yield* Fiber.join(slowFiber);
        const lines = `${fastResult.output}\n${slowResult.output}\n${thirdResult.output}`;
        const successes = (lines.match(/SUCCESS/gu) ?? []).length;
        const failures = (lines.match(/FAILURE/gu) ?? []).length;
        expect(successes).toBe(0);
        expect(failures).toBe(3);
        expect(fastResult.output).toContain("FAILURE");
        expect(slowResult.output).toContain("FAILURE");
        expect(thirdResult.output).toContain("FAILURE");
      }),
    20_000
  );
});
