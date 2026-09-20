import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "@effect/vitest";
import { Effect, Exit, Predicate, Scope } from "effect";

import { createCliIdentityStore } from "../src/identity-store.ts";

it.each(["SIGINT", "SIGTERM"] as const)(
  "releases the CLI identity lock on %s",
  async (signal) => {
    const root = await mkdtemp(path.join(tmpdir(), "qop-main-"));
    // Hold the registry request open so shutdown interrupts a running command.
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || Predicate.isString(address)) {
      throw new Error("Expected a TCP listener");
    }
    const requested = once(server, "request", {
      signal: AbortSignal.timeout(5000),
    });
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../src/main.ts", import.meta.url)),
        "link",
        "--account",
        "alice",
      ],
      {
        env: {
          ...process.env,
          QOP_DATA_DIR: root,
          QOP_REGISTRY_ADDRESS: "0x1111111111111111111111111111111111111111",
          QOP_REGISTRY_CHAIN_ID: "31337",
          QOP_RPC_URL: `http://127.0.0.1:${address.port}`,
        },
        stdio: "ignore",
      }
    );
    const exited = once(child, "exit");
    const store = createCliIdentityStore(root);
    try {
      await requested;
      const blocked = await Effect.runPromise(
        Effect.scoped(store.acquireLock()).pipe(Effect.result)
      );
      expect(blocked._tag).toBe("Failure");
      if (blocked._tag === "Failure") {
        expect(blocked.failure.operation).toBe("conflict");
      }
      child.kill(signal);
      await exited;
      await Effect.runPromise(Effect.scoped(store.acquireLock()));
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await exited;
      }
      server.closeAllConnections();
      server.close();
      await rm(root, { force: true, recursive: true });
    }
  },
  10_000
);

it("runs status while the exclusive lock is held", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qop-status-"));
  const store = createCliIdentityStore(root);
  const scope = Scope.makeUnsafe();
  try {
    await Effect.runPromise(Scope.provide(scope)(store.acquireLock()));
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../src/main.ts", import.meta.url)), "status"],
      {
        env: {
          ...process.env,
          QOP_DATA_DIR: root,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let output = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
    });
    const [code] = await once(child, "exit");
    expect(code).toBe(0);
    expect(output).toContain("No CLI identity");
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await rm(root, { force: true, recursive: true });
  }
}, 10_000);
