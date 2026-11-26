import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

import {
  deviceKeyFromEd25519SecretKey,
  PeerId,
  peerIdFromDeviceKey,
} from "@qop/identity";
import { registryAbi } from "@qop/protocol";
import { Effect, Schema } from "effect";
import {
  bytesToHex,
  decodeFunctionData,
  encodeFunctionResult,
  keccak256,
  toBytes,
} from "viem";
import type { Address, Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const activeChildren: ChildProcess[] = [];
const activeServers: Server[] = [];

const REGISTRY_ADDRESS = "0x3333333333333333333333333333333333333333";

const makeTempDir = async (prefix: string) => {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  await chmod(dir, 0o700);
  tempDirs.push(dir);

  return dir;
};

afterEach(async () => {
  for (const child of activeChildren.splice(0)) {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }

  await Promise.all(
    activeServers.splice(0).map(async (server) => {
      server.close();
      await once(server, "close").catch(() => null);
    })
  );

  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

interface TestAccount {
  readonly deviceKeyHex: Hex;
  readonly handle: string;
  readonly owner: Address;
  readonly peerId: string;
  readonly qid: bigint;
  readonly secret: Uint8Array;
}

interface JsonRpcRequest {
  readonly id: number | string;
  readonly method: string;
  readonly params?: readonly unknown[];
}

interface JsonRpcBlock {
  readonly hash: string;
  readonly number: string;
  readonly timestamp: string;
}

type JsonRpcResult = string | JsonRpcBlock;

interface RegistryLookup {
  readonly byDeviceKey: ReadonlyMap<string, TestAccount>;
  readonly byHandleHash: ReadonlyMap<string, TestAccount>;
  readonly byOwner: ReadonlyMap<string, TestAccount>;
  readonly byQid: ReadonlyMap<bigint, TestAccount>;
}

const makeAccount = (
  qid: bigint,
  handle: string,
  owner: Address
): TestAccount => {
  const secret = new Uint8Array(randomBytes(32));
  const publicKey = Effect.runSync(deviceKeyFromEd25519SecretKey(secret));

  const peerId = Effect.runSync(
    peerIdFromDeviceKey(publicKey).pipe(
      Effect.flatMap(Schema.encodeEffect(PeerId))
    )
  );

  // SAFETY: bytesToHex always returns a 0x-prefixed hex string.
  const deviceKeyHex = bytesToHex(publicKey).toLowerCase() as Hex;

  return { deviceKeyHex, handle, owner, peerId, qid, secret };
};

const seedCliDataDir = async (account: TestAccount): Promise<string> => {
  const dir = await makeTempDir(`qop-cli-${account.handle}-`);
  const keyPath = path.join(dir, "device.key");
  const identityPath = path.join(dir, "identity.json");

  await writeFile(keyPath, account.secret, { mode: 0o600 });
  await chmod(keyPath, 0o600);

  const identity = {
    account: account.owner,
    chainId: "31337",
    deviceKey: account.deviceKeyHex,
    handle: account.handle,
    peerId: account.peerId,
    qid: account.qid.toString(),
    registry: REGISTRY_ADDRESS,
    version: 1,
  };

  await writeFile(identityPath, `${JSON.stringify(identity, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(identityPath, 0o600);

  return dir;
};

const resolveEthCall = (lookup: RegistryLookup, data: Hex): string => {
  const decoded = decodeFunctionData({
    abi: registryAbi,
    data,
  });

  switch (decoded.functionName) {
    case "account": {
      const acc = lookup.byQid.get(decoded.args[0]);

      return encodeFunctionResult({
        abi: registryAbi,
        functionName: "account",
        result: acc
          ? {
              handle: acc.handle,
              nonce: 0n,
              owner: acc.owner,
              ownerVersion: 1,
              registeredAt: 1_700_000_000n,
            }
          : {
              handle: "",
              nonce: 0n,
              owner: "0x0000000000000000000000000000000000000000",
              ownerVersion: 0,
              registeredAt: 0n,
            },
      });
    }

    case "listActiveDevices": {
      const acc = lookup.byQid.get(decoded.args[0]);

      return encodeFunctionResult({
        abi: registryAbi,
        functionName: "listActiveDevices",
        result: acc ? [acc.deviceKeyHex] : [],
      });
    }

    case "qidByDeviceKey": {
      const acc = lookup.byDeviceKey.get(decoded.args[0].toLowerCase());

      return encodeFunctionResult({
        abi: registryAbi,
        functionName: "qidByDeviceKey",
        result: acc ? acc.qid : 0n,
      });
    }

    case "qidByHandleHash": {
      const acc = lookup.byHandleHash.get(decoded.args[0].toLowerCase());

      return encodeFunctionResult({
        abi: registryAbi,
        functionName: "qidByHandleHash",
        result: acc ? acc.qid : 0n,
      });
    }

    case "qidByOwner": {
      const acc = lookup.byOwner.get(decoded.args[0].toLowerCase());

      return encodeFunctionResult({
        abi: registryAbi,
        functionName: "qidByOwner",
        result: acc ? acc.qid : 0n,
      });
    }

    case "deviceKeyRemoved": {
      return encodeFunctionResult({
        abi: registryAbi,
        functionName: "deviceKeyRemoved",
        result: false,
      });
    }

    default: {
      return "0x";
    }
  }
};

const resolveRpcMethod = (
  lookup: RegistryLookup,
  body: JsonRpcRequest
): JsonRpcResult => {
  if (body.method === "eth_chainId") {
    return "0x7a69";
  }

  if (body.method === "eth_blockNumber") {
    return "0x10";
  }

  if (body.method === "eth_getBlockByNumber") {
    return {
      hash: `0x${"ab".repeat(32)}`,
      number: "0x10",
      timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
    };
  }

  if (body.method === "eth_call") {
    // SAFETY: eth_call params[0] is the call object containing hex calldata.
    const callObj = (body.params?.[0] ?? {}) as { readonly data?: Hex };

    return resolveEthCall(lookup, callObj.data ?? "0x");
  }

  return "0x0";
};

const isRpcBatch = (
  value: JsonRpcRequest | readonly JsonRpcRequest[]
): value is readonly JsonRpcRequest[] => Array.isArray(value);

const startMockRegistryRpc = async (
  accounts: readonly TestAccount[]
): Promise<{ readonly url: string }> => {
  const lookup: RegistryLookup = {
    byDeviceKey: new Map(accounts.map((a) => [a.deviceKeyHex, a])),
    byHandleHash: new Map(
      accounts.map((a) => [keccak256(toBytes(a.handle)).toLowerCase(), a])
    ),
    byOwner: new Map(accounts.map((a) => [a.owner.toLowerCase(), a])),
    byQid: new Map(accounts.map((a) => [a.qid, a])),
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      // SAFETY: HTTP body is a valid JSON-RPC 2.0 request object or batch array from viem.
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as
        | JsonRpcRequest
        | readonly JsonRpcRequest[];

      const payload = isRpcBatch(parsed)
        ? parsed.map((item) => ({
            id: item.id,
            jsonrpc: "2.0",
            result: resolveRpcMethod(lookup, item),
          }))
        : {
            id: parsed.id,
            jsonrpc: "2.0",
            result: resolveRpcMethod(lookup, parsed),
          };

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });

  activeServers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();

  if (!address || !(address instanceof Object)) {
    throw new Error("Failed to bind mock JSON-RPC server");
  }

  return { url: `http://127.0.0.1:${address.port}` };
};

const waitForOutput = (
  child: ChildProcess,
  pattern: RegExp,
  timeoutMs = 15_000
): Promise<{ readonly match: RegExpExecArray; readonly stdout: string }> =>
  Effect.runPromise(
    Effect.callback<
      { readonly match: RegExpExecArray; readonly stdout: string },
      Error
    >((resume) => {
      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resume(
            Effect.fail(
              new Error(
                `Timed out waiting for ${String(pattern)}. stdout=${stdout} stderr=${stderr}`
              )
            )
          );
        }
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
        const match = pattern.exec(stdout);

        if (match && !settled) {
          settled = true;
          clearTimeout(timer);
          resume(Effect.succeed({ match, stdout }));
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });

      child.on("exit", (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resume(
            Effect.fail(
              new Error(
                `Process exited early with code ${String(code)} before ${String(pattern)}. stdout=${stdout} stderr=${stderr}`
              )
            )
          );
        }
      });
    })
  );

const stopChild = async (child: ChildProcess) => {
  if (child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await once(child, "exit").catch(() => null);
};

const waitForEmptyMailbox = (
  dbPath: string,
  attemptsLeft = 20
): Promise<number> => {
  const db = new DatabaseSync(dbPath, { readOnly: true });

  // SAFETY: COUNT(*) always returns a single row with numeric count.
  const row = db.prepare("SELECT COUNT(*) AS count FROM envelopes").get() as {
    readonly count: number;
  };

  db.close();

  if (row.count === 0 || attemptsLeft <= 1) {
    return Promise.resolve(row.count);
  }

  return delay(100).then(() => waitForEmptyMailbox(dbPath, attemptsLeft - 1));
};

describe("multi-process CLI + standalone qop-mailbox offline delivery", () => {
  it("keeps message queued without a mailbox, then delivers end-to-end across separate CLI and mailbox processes", async () => {
    const mailboxDir = await makeTempDir("qop-mailbox-e2e-");

    const alice = makeAccount(
      1n,
      "alice",
      "0x1111111111111111111111111111111111111111"
    );

    const bob = makeAccount(
      2n,
      "bob",
      "0x2222222222222222222222222222222222222222"
    );

    const rpc = await startMockRegistryRpc([alice, bob]);

    const mailboxMain = path.resolve(
      import.meta.dirname,
      "..",
      "src",
      "main.ts"
    );

    const cliMain = path.resolve(
      import.meta.dirname,
      "..",
      "..",
      "cli",
      "src",
      "main.ts"
    );

    const mailboxProc = spawn(process.execPath, [mailboxMain], {
      env: {
        ...process.env,
        QOP_LISTEN_ADDRS: "/ip4/127.0.0.1/udp/0/quic-v1",
        QOP_MAILBOX_DATA_DIR: mailboxDir,
        QOP_REGISTRY_ADDRESS: REGISTRY_ADDRESS,
        QOP_REGISTRY_CHAIN_ID: "31337",
        QOP_RPC_URL: rpc.url,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    activeChildren.push(mailboxProc);

    const { match: addrMatch } = await waitForOutput(
      mailboxProc,
      /qop-mailbox addr=(?<addr>\S+)/u
    );

    const mailboxAddr = addrMatch.groups?.addr;

    if (!mailboxAddr) {
      throw new Error("Missing mailbox listen address");
    }

    const secretText = "offline hello via real cli and mailbox";

    // 1. Failing case (without mailbox): real CLI tries to send to offline Bob and waits to retry.
    const aliceNoMailboxDir = await seedCliDataDir(alice);

    const aliceNoMailbox = spawn(
      process.execPath,
      [cliMain, "start", "--to", "bob", "--message", secretText],
      {
        env: {
          ...process.env,
          QOP_DATA_DIR: aliceNoMailboxDir,
          QOP_MAILBOX_ADDRS: "",
          QOP_REGISTRY_ADDRESS: REGISTRY_ADDRESS,
          QOP_REGISTRY_CHAIN_ID: "31337",
          QOP_RELAY_ADDRS: "",
          QOP_RPC_URL: rpc.url,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    activeChildren.push(aliceNoMailbox);
    await waitForOutput(aliceNoMailbox, /Waiting for @bob/iu);
    await stopChild(aliceNoMailbox);

    // 2. Passing case (with mailbox): real CLI falls back to the standalone mailbox process, marks sent, and exits.
    const aliceWithMailboxDir = await seedCliDataDir(alice);

    const aliceWithMailbox = spawn(
      process.execPath,
      [cliMain, "start", "--to", "bob", "--message", secretText],
      {
        env: {
          ...process.env,
          QOP_DATA_DIR: aliceWithMailboxDir,
          QOP_MAILBOX_ADDRS: mailboxAddr,
          QOP_REGISTRY_ADDRESS: REGISTRY_ADDRESS,
          QOP_REGISTRY_CHAIN_ID: "31337",
          QOP_RELAY_ADDRS: "",
          QOP_RPC_URL: rpc.url,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    activeChildren.push(aliceWithMailbox);
    await waitForOutput(aliceWithMailbox, /Sent to @bob\./iu);
    await stopChild(aliceWithMailbox);

    // Inspect mailbox.db on disk: 1 encrypted envelope row, zero plaintext.
    const dbPath = path.join(mailboxDir, "mailbox.db");
    const dbBefore = new DatabaseSync(dbPath, { readOnly: true });

    // SAFETY: SELECT returns SQLite row objects matching the envelopes schema.
    const rowsBefore = dbBefore
      .prepare(
        "SELECT recipient_device_key, sender_device_key, envelope FROM envelopes"
      )
      .all() as {
      readonly envelope: Uint8Array;
      readonly recipient_device_key: string;
      readonly sender_device_key: string;
    }[];

    dbBefore.close();

    expect(rowsBefore).toHaveLength(1);
    expect(rowsBefore[0]?.recipient_device_key).toBe(bob.deviceKeyHex);
    expect(rowsBefore[0]?.sender_device_key).toBe(alice.deviceKeyHex);
    expect(
      Buffer.from(rowsBefore[0]?.envelope ?? new Uint8Array()).toString("utf-8")
    ).not.toContain(secretText);

    // 3. Bob's real CLI starts AFTER Alice has exited, drains the mailbox, decrypts, logs, and ACKs.
    const bobDir = await seedCliDataDir(bob);

    const bobProc = spawn(process.execPath, [cliMain, "start"], {
      env: {
        ...process.env,
        QOP_DATA_DIR: bobDir,
        QOP_MAILBOX_ADDRS: mailboxAddr,
        QOP_REGISTRY_ADDRESS: REGISTRY_ADDRESS,
        QOP_REGISTRY_CHAIN_ID: "31337",
        QOP_RELAY_ADDRS: "",
        QOP_RPC_URL: rpc.url,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    activeChildren.push(bobProc);
    await waitForOutput(bobProc, new RegExp(`@alice: ${secretText}`, "u"));

    const remaining = await waitForEmptyMailbox(dbPath);
    expect(remaining).toBe(0);

    await stopChild(bobProc);
    await stopChild(mailboxProc);
  }, 45_000);
});
