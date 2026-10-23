import { createServer } from "node:http";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";

import { ApiRoutesLive } from "./app.ts";
import { Env } from "./env.ts";

const ApplicationLive = Layer.unwrap(
  Env.make.pipe(
    Effect.map((env) =>
      HttpRouter.serve(ApiRoutesLive).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(createServer, { port: env.PORT })
        )
      )
    )
  )
);

Layer.launch(ApplicationLive).pipe(NodeRuntime.runMain);
