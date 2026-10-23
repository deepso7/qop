// Vercel function entry. `build.ts` bundles it into `.vercel/output`.
// Services are built on the first request and reused while the instance stays warm.
import { NodeHttpServer } from "@effect/platform-node";
import { Layer } from "effect";
import { HttpRouter } from "effect/http";

import { ApiRoutesLive } from "./app.ts";

const { handler } = HttpRouter.toWebHandler(
  ApiRoutesLive.pipe(Layer.provide(NodeHttpServer.layerHttpServices))
);

export default {
  // Vercel passes its own context as the second argument; it isn't an Effect context.
  fetch: (request: Request) => handler(request),
};
