import { HttpApi, OpenApi } from "effect/unstable/httpapi";

import { DeviceApiGroup } from "./device-api.ts";
import { DeviceSessionApiGroup } from "./device-session-api.ts";
import { RegistrationApiGroup } from "./registration-api.ts";

export class QopHttpApi extends HttpApi.make("qop-api")
  .add(DeviceApiGroup)
  .add(DeviceSessionApiGroup)
  .add(RegistrationApiGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "QOP API",
      version: "1",
    })
  ) {}
