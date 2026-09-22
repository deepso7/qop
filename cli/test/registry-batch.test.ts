import { once } from "node:events";
import { createServer } from "node:http";

import { registryAbi } from "@qop/protocol";
import { Effect, Predicate, Schema } from "effect";
import { encodeFunctionData, encodeFunctionResult } from "viem";
import { describe, expect, it } from "vitest";

import { configuredRegistry } from "../src/config.ts";

const DEVICE_KEY = `0x${"22".repeat(32)}` as const;
const OWNER = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const REGISTRY = "0x1111111111111111111111111111111111111111";

const accountSelector = encodeFunctionData({
  abi: registryAbi,
  args: [0n],
  functionName: "account",
}).slice(0, 10);

const devicesSelector = encodeFunctionData({
  abi: registryAbi,
  args: [0n],
  functionName: "listActiveDevices",
}).slice(0, 10);

const RpcCall = Schema.Struct({
  id: Schema.Number,
  method: Schema.String,
  params: Schema.optionalKey(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          data: Schema.optionalKey(Schema.String),
        }),
        Schema.String,
      ])
    )
  ),
});

const decodeRpcBody = Schema.decodeUnknownSync(
  Schema.Union([RpcCall, Schema.Array(RpcCall)])
);

const calldataOf = (call: typeof RpcCall.Type) => {
  const tx = call.params?.[0];
  return tx && Predicate.isObject(tx) ? tx.data : undefined;
};

const rpcResult = (call: typeof RpcCall.Type) => {
  if (call.method === "eth_blockNumber") {
    return "0x63";
  }
  const data = calldataOf(call);
  if (call.method !== "eth_call" || !data) {
    throw new Error(`unexpected ${call.method}`);
  }
  if (data.startsWith(accountSelector)) {
    return encodeFunctionResult({
      abi: registryAbi,
      functionName: "account",
      result: {
        handle: "alice",
        nonce: 0n,
        owner: OWNER,
        ownerVersion: 3,
        registeredAt: 1_700_000_000n,
      },
    });
  }
  if (data.startsWith(devicesSelector)) {
    return encodeFunctionResult({
      abi: registryAbi,
      functionName: "listActiveDevices",
      result: [DEVICE_KEY],
    });
  }
  throw new Error("unexpected calldata");
};

const functionName = (call: typeof RpcCall.Type) => {
  const data = calldataOf(call);
  if (data?.startsWith(accountSelector)) {
    return "account";
  }
  if (data?.startsWith(devicesSelector)) {
    return "listActiveDevices";
  }
  throw new Error("unexpected calldata");
};

describe("CLI registry HTTP batch", () => {
  it("sends account and listActiveDevices as one JSON-RPC HTTP request", async () => {
    const posts: (typeof RpcCall.Type)[][] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on("end", () => {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
        const decoded = decodeRpcBody(body);
        const batch = Array.isArray(decoded) ? decoded : [decoded];
        posts.push([...batch]);
        // `rpcResult` throws on unexpected input. This listener is async, so
        // an uncaught throw becomes an unhandled exception and the client
        // never gets a body. Answer that call with a JSON-RPC error instead.
        const results = batch.map((call) => {
          try {
            return {
              id: call.id,
              jsonrpc: "2.0" as const,
              result: rpcResult(call),
            };
          } catch (error) {
            return {
              error: {
                code: -32_603,
                message: error instanceof Error ? error.message : String(error),
              },
              id: call.id,
              jsonrpc: "2.0" as const,
            };
          }
        });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify(Array.isArray(decoded) ? results : results[0])
        );
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || Predicate.isString(address)) {
      throw new Error("Expected a TCP listener");
    }
    const previousRpcUrl = process.env.QOP_RPC_URL;
    const previousRegistry = process.env.QOP_REGISTRY_ADDRESS;
    const previousChainId = process.env.QOP_REGISTRY_CHAIN_ID;
    const restoreEnv = () => {
      if (previousRpcUrl === undefined) {
        delete process.env.QOP_RPC_URL;
      } else {
        process.env.QOP_RPC_URL = previousRpcUrl;
      }
      if (previousRegistry === undefined) {
        delete process.env.QOP_REGISTRY_ADDRESS;
      } else {
        process.env.QOP_REGISTRY_ADDRESS = previousRegistry;
      }
      if (previousChainId === undefined) {
        delete process.env.QOP_REGISTRY_CHAIN_ID;
      } else {
        process.env.QOP_REGISTRY_CHAIN_ID = previousChainId;
      }
    };
    process.env.QOP_RPC_URL = `http://127.0.0.1:${address.port}`;
    process.env.QOP_REGISTRY_ADDRESS = REGISTRY;
    process.env.QOP_REGISTRY_CHAIN_ID = "31337";
    try {
      const { reader } = await Effect.runPromise(configuredRegistry());
      const account = await Effect.runPromise(reader.lookupQid(42n));
      expect(account?.handle).toBe("alice");
      expect(account?.qid).toBe(42n);
      // `batch: true` sends every flush as a JSON-RPC array, including a
      // one-call flush. Two posts: head, then account + listActiveDevices.
      expect(posts).toHaveLength(2);
      expect(posts[0]?.map((call) => call.method)).toEqual(["eth_blockNumber"]);
      expect(posts[1]?.map((call) => call.method)).toEqual([
        "eth_call",
        "eth_call",
      ]);
      expect(posts[1]?.map(functionName)).toEqual([
        "account",
        "listActiveDevices",
      ]);
    } finally {
      restoreEnv();
      server.closeAllConnections();
      server.close();
    }
  });
});
