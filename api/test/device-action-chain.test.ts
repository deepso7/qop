import { once } from "node:events";
import { createServer } from "node:http";

import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { DeviceActionChain } from "../src/device-action/chain.ts";
import { Env } from "../src/env.ts";

const RpcRequest = Schema.Struct({
  id: Schema.Number,
  method: Schema.String,
  params: Schema.Array(Schema.Unknown),
});
const decodeRequests = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(RpcRequest))
);

describe("device action chain time", () => {
  it("uses latest chain time despite a nonzero confirmation depth", async () => {
    const requests: string[] = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
      }
      const replies = decodeRequests(body).map((rpc) => {
        requests.push(`${rpc.method}:${String(rpc.params[0])}`);
        return {
          id: rpc.id,
          jsonrpc: "2.0",
          result:
            rpc.method === "eth_blockNumber"
              ? "0x64"
              : {
                  number: "0x64",
                  timestamp: `0x${(rpc.params[0] === "latest" ? 1_700_001_200 : 1_700_001_000).toString(16)}`,
                  transactions: [],
                },
        };
      });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(replies));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = Schema.decodeUnknownSync(
        Schema.Struct({ port: Schema.Number })
      )(server.address());
      const env = Layer.succeed(
        Env,
        Env.of({
          CHAIN_ID: 31_337n,
          DATABASE_URL: "postgresql://test",
          PORT: 3000,
          REGISTRATION_PRIVATE_KEY: `0x${"01".repeat(32)}`,
          REGISTRY_ADDRESS: "0x1111111111111111111111111111111111111111",
          REGISTRY_CONFIRMATIONS: 12,
          RELAYER_PRIVATE_KEY: `0x${"02".repeat(32)}`,
          RPC_URL: new URL(`http://127.0.0.1:${address.port}`),
        })
      );
      const timestamp = await Effect.runPromise(
        Effect.gen(function* () {
          const chain = yield* DeviceActionChain;
          return yield* chain.blockTimestamp;
        }).pipe(
          Effect.provide(DeviceActionChain.layer.pipe(Layer.provide(env)))
        )
      );
      expect(timestamp).toBe(1_700_001_200n);
      expect(requests).toEqual(["eth_getBlockByNumber:latest"]);
    } finally {
      server.closeAllConnections();
      await server[Symbol.asyncDispose]();
    }
  });
});
