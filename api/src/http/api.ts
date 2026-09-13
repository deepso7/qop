import { HttpApi, OpenApi } from "effect/unstable/httpapi";

import { DeviceActionsApiGroup } from "./device-action-api.ts";
import { RegistrationApiGroup } from "./registration-api.ts";

export class QopHttpApi extends HttpApi.make("qop-api")
  .add(RegistrationApiGroup)
  .add(DeviceActionsApiGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "QOP API",
      version: "1",
    })
  ) {}
