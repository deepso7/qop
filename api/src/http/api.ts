import { HttpApi, OpenApi } from "effect/unstable/httpapi";

import { RegistrationApiGroup } from "./registration-api.ts";

export class QopHttpApi extends HttpApi.make("qop-api")
  .add(RegistrationApiGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "QOP API",
      version: "1",
    })
  ) {}
