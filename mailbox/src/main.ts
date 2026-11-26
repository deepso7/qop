import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { registryAbi } from "@qop/protocol";
import { Effect } from "effect";
import { createPublicClient, http, isAddress } from "viem";
import type { Hex } from "viem";

import { startMailboxServer } from "./server.ts";
import type { MailboxRegistry } from "./server.ts";
import { openMailboxStore } from "./store.ts";

const DEFAULT_LISTEN_ADDR = "/ip4/0.0.0.0/udp/19877/quic-v1";
const DEFAULT_CHAIN_ID = 31_337;
const DEFAULT_TTL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const KEY_FILE = "mailbox.key";
const KEY_BYTES = 32;
const MODE_DIR = 0o700;
const MODE_FILE = 0o600;

const parseAddrs = (raw: string | undefined, fallback: readonly string[]) => {
  if (!raw) {
    return fallback;
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

/** Load the 32-byte mailbox identity key, creating it only when absent. */
export const loadOrCreateKey = async (dataDir: string): Promise<Uint8Array> => {
  await mkdir(dataDir, { mode: MODE_DIR, recursive: true });
  await chmod(dataDir, MODE_DIR);

  const keyPath = path.join(dataDir, KEY_FILE);

  try {
    const existing = await readFile(keyPath);

    if (existing.byteLength !== KEY_BYTES) {
      throw new Error(
        `Invalid mailbox key at ${keyPath}: expected ${KEY_BYTES} bytes, got ${existing.byteLength}`
      );
    }

    return new Uint8Array(existing);
  } catch (error) {
    // SAFETY: Node.js fs errors are Error instances with a string errno `code`.
    const errno = error as NodeJS.ErrnoException;

    if (errno.code !== "ENOENT") {
      throw error;
    }
  }

  const created = new Uint8Array(randomBytes(KEY_BYTES));
  await writeFile(keyPath, created, { mode: MODE_FILE });
  await chmod(keyPath, MODE_FILE);

  return created;
};

const main = async () => {
  const rpcUrl = process.env.QOP_RPC_URL?.trim();
  const registryAddress = process.env.QOP_REGISTRY_ADDRESS?.trim();

  if (!rpcUrl) {
    throw new Error("QOP_RPC_URL is required");
  }

  if (!registryAddress || !isAddress(registryAddress)) {
    throw new Error("QOP_REGISTRY_ADDRESS must be a valid 0x address");
  }

  const chainId = Number(process.env.QOP_REGISTRY_CHAIN_ID ?? DEFAULT_CHAIN_ID);
  const ttlDays = Number(process.env.QOP_MAILBOX_TTL_DAYS ?? DEFAULT_TTL_DAYS);

  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error("QOP_REGISTRY_CHAIN_ID must be a positive integer");
  }

  if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
    throw new Error("QOP_MAILBOX_TTL_DAYS must be a positive number");
  }

  const dataDir =
    process.env.QOP_MAILBOX_DATA_DIR?.trim() ||
    path.join(os.homedir(), ".qop-mailbox");

  const listenAddrs = parseAddrs(process.env.QOP_LISTEN_ADDRS, [
    DEFAULT_LISTEN_ADDR,
  ]);

  const [firstListenAddr, ...restListenAddrs] = listenAddrs;

  if (!firstListenAddr) {
    throw new Error("QOP_LISTEN_ADDRS must contain at least one multiaddr");
  }

  const relayAddrs = parseAddrs(process.env.QOP_RELAY_ADDRS, []);
  const keypair = await loadOrCreateKey(dataDir);

  const publicClient = createPublicClient({
    transport: http(rpcUrl, { batch: true, retryCount: 0, timeout: 4000 }),
  });

  const rpcChainId = await publicClient.getChainId();

  if (rpcChainId !== chainId) {
    throw new Error(
      `QOP_REGISTRY_CHAIN_ID mismatch: expected ${chainId}, RPC returned ${rpcChainId}`
    );
  }

  const store = await Effect.runPromise(
    openMailboxStore(dataDir, { ttlMs: Math.round(ttlDays * DAY_MS) })
  );

  // One `eth_call` per cache miss: QOPIdentityRegistry clears `qidByDeviceKey`
  // on removeDevice/wipeDevices/recoverOwner, so `qid > 0n` iff active.
  const registry: MailboxRegistry = {
    lookupDeviceQid: (deviceKey) =>
      Effect.tryPromise({
        catch: (cause) => cause,
        try: async () => {
          const qid = await publicClient.readContract({
            abi: registryAbi,
            address: registryAddress,
            // SAFETY: callers normalize device keys to 0x-prefixed 32-byte hex.
            args: [deviceKey as Hex],
            functionName: "qidByDeviceKey",
          });

          return qid > 0n ? qid : null;
        },
      }),
  };

  const server = startMailboxServer({
    keypair,
    listenAddrs: [firstListenAddr, ...restListenAddrs],
    registry,
    relayAddrs,
    store,
  });

  const addrs = server.listenAddrs();
  process.stdout.write(`qop-mailbox peerId=${server.peerId}\n`);

  for (const addr of addrs) {
    process.stdout.write(`qop-mailbox addr=${addr}\n`);
  }

  const shutdown = () => {
    server.close();
    store.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`qop-mailbox fatal: ${message}\n`);
    process.exit(1);
  }
}
