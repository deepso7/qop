import { Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { QopHttpApi } from "./api.ts";
import { DeviceApiHandlers } from "./device-handlers.ts";
import { RegistrationApiHandlers } from "./registration-handlers.ts";

export const QopHttpApiRoutes = HttpApiBuilder.layer(QopHttpApi, {
  openapiPath: "/openapi.json",
}).pipe(
  Layer.provide(DeviceApiHandlers),
  Layer.provide(RegistrationApiHandlers)
);
