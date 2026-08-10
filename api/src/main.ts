import { createServer } from "node:http";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";

import { DeviceSessionServiceLive } from "./device-session/service.ts";
import { DeviceObservationLive } from "./device/observation.ts";
import { Env } from "./env.ts";
import { QopHttpApiRoutes } from "./http/routes.ts";
import { RegistrationEnrollmentLive } from "./registration/enrollment.ts";
import { registrationSignerLayer } from "./registration/signer.ts";

const ApplicationLive = Layer.unwrap(
  Env.make.pipe(
    Effect.map((env) => {
      const registration = RegistrationEnrollmentLive.pipe(
        Layer.provide(registrationSignerLayer(env.REGISTRATION_PRIVATE_KEY))
      );
      const routes = QopHttpApiRoutes.pipe(
        Layer.provide(DeviceObservationLive),
        Layer.provide(DeviceSessionServiceLive),
        Layer.provide(registration)
      );
      return HttpRouter.serve(routes).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(createServer, { port: env.PORT })
        )
      );
    })
  )
);

Layer.launch(ApplicationLive).pipe(NodeRuntime.runMain);
