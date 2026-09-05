import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import type { RegistrationEnrollmentError } from "../registration/enrollment.ts";
import { RegistrationEnrollment } from "../registration/enrollment.ts";
import { normalizeRegistrationDigest } from "../registration/inputs.ts";
import { QopHttpApi } from "./api.ts";
import {
  RegistrationConflict,
  RegistrationInvalid,
  RegistrationNotFound,
  RegistrationServiceUnavailable,
  RegistrationUnauthorized,
} from "./registration-api.ts";

export type RegistrationHttpError =
  | RegistrationConflict
  | RegistrationInvalid
  | RegistrationNotFound
  | RegistrationServiceUnavailable
  | RegistrationUnauthorized;

export const mapRegistrationHttpError = (
  error: RegistrationEnrollmentError
): RegistrationHttpError => {
  switch (error._tag) {
    case "RegistrationAdmissionUnauthorized":
    case "RegistrationSignatureMismatch": {
      return new RegistrationUnauthorized();
    }
    case "RegistrationHandleUnavailable": {
      return error.qid === undefined
        ? new RegistrationConflict({ kind: "handle-unavailable" })
        : new RegistrationConflict({
            kind: "handle-unavailable",
            qid: error.qid.toString(),
          });
    }
    case "RegistrationActiveHandleConflict": {
      return new RegistrationConflict({ kind: "handle-unavailable" });
    }
    case "RegistrationOwnerUnavailable": {
      return error.qid === undefined
        ? new RegistrationConflict({ kind: "owner-unavailable" })
        : new RegistrationConflict({
            kind: "owner-unavailable",
            qid: error.qid.toString(),
          });
    }
    case "RegistrationActiveOwnerConflict": {
      return new RegistrationConflict({ kind: "owner-unavailable" });
    }
    case "RegistrationNonceUsed":
    case "RegistrationNonceConflict": {
      return new RegistrationConflict({ kind: "nonce-used" });
    }
    case "RegistrationTransitionConflict": {
      return new RegistrationConflict({
        actual: error.actual,
        kind: "transition-conflict",
      });
    }
    case "RegistrationIntentNotFound": {
      return new RegistrationNotFound({ digest: error.digest });
    }
    case "IdentityCryptoError":
    case "RegistrationDeadlineInvalid":
    case "RegistrationInputError":
    case "RegistryInputError": {
      return new RegistrationInvalid();
    }
    default: {
      return new RegistrationServiceUnavailable();
    }
  }
};

const transportErrors = Effect.mapError(mapRegistrationHttpError);

export const RegistrationApiHandlers = HttpApiBuilder.group(
  QopHttpApi,
  "registrations",
  Effect.fn("RegistrationApiHandlers.make")(function* (handlers) {
    const enrollment = yield* RegistrationEnrollment;

    return handlers
      .handle("register", ({ payload }) =>
        enrollment.register(payload).pipe(transportErrors)
      )
      .handle("get", ({ params }) =>
        normalizeRegistrationDigest(params.digest).pipe(
          Effect.flatMap(enrollment.reconcile),
          transportErrors,
          Effect.map((registration) => ({
            ...registration,
            qid: registration.qid?.toString() ?? null,
          }))
        )
      );
  })
);

export const RegistrationApiHandlersLive = RegistrationApiHandlers.pipe(
  Layer.provide(RegistrationEnrollment.layer)
);
