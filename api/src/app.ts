import { Effect, Layer } from "effect";

import { DeviceActionEnrollmentLive } from "./device-action/enrollment.ts";
import { deviceActionRelayerLayer } from "./device-action/relayer.ts";
import { Env } from "./env.ts";
import { QopHttpApiRoutes } from "./http/routes.ts";
import { RegistrationEnrollmentLive } from "./registration/enrollment.ts";
import { registrationRelayerLayer } from "./registration/relayer.ts";
import { registrationSignerLayer } from "./registration/signer.ts";

/** The API routes with every service wired. `main.ts` serves them over Node HTTP, `vercel.ts` as a fetch handler. */
export const ApiRoutesLive = Layer.unwrap(
  Env.make.pipe(
    Effect.map((env) => {
      const registration = RegistrationEnrollmentLive.pipe(
        Layer.provide(registrationSignerLayer(env.REGISTRATION_PRIVATE_KEY)),
        Layer.provide(
          registrationRelayerLayer(env.RELAYER_PRIVATE_KEY).pipe(
            Layer.provide(Layer.succeed(Env, env))
          )
        )
      );

      const deviceActions = DeviceActionEnrollmentLive.pipe(
        Layer.provide(
          deviceActionRelayerLayer(env.RELAYER_PRIVATE_KEY).pipe(
            Layer.provide(Layer.succeed(Env, env))
          )
        )
      );

      return QopHttpApiRoutes.pipe(
        Layer.provide(registration),
        Layer.provide(deviceActions)
      );
    })
  )
);
