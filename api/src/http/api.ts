import { strictParseOptions } from "@qop/identity";
import { HttpApi, OpenApi } from "effect/http-api";

import { DeviceActionsApiGroup } from "./device-action-api.ts";
import { RegistrationApiGroup } from "./registration-api.ts";

export class QopHttpApi extends HttpApi.make("qop-api")
  .add(RegistrationApiGroup)
  .add(DeviceActionsApiGroup)
  // Request bodies carry signed intents, so reject fields the schemas don't model.
  .annotate(HttpApi.PayloadParseOptions, strictParseOptions)
  .annotateMerge(
    OpenApi.annotations({
      title: "QOP API",
      version: "1",
    })
  ) {}
