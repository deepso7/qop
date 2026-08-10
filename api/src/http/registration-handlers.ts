import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type { Address, Hash, Hex } from "viem";

import type { RegistrationEnrollmentError } from "../registration/enrollment.ts";
import { RegistrationEnrollment } from "../registration/enrollment.ts";
import { QopHttpApi } from "./api.ts";
import {
  RegistrationConflict,
  RegistrationExpired,
  RegistrationInvalid,
  RegistrationNotFound,
  RegistrationServiceUnavailable,
  RegistrationUnauthorized,
} from "./registration-api.ts";

export type RegistrationHttpError =
  | RegistrationConflict
  | RegistrationExpired
  | RegistrationInvalid
  | RegistrationNotFound
  | RegistrationServiceUnavailable
  | RegistrationUnauthorized;

export const mapRegistrationHttpError = (
  error: RegistrationEnrollmentError
): RegistrationHttpError => {
  switch (error._tag) {
    case "RegistrationHandleUnavailable": {
      return new RegistrationConflict({
        kind: "handle-unavailable",
        qid: error.qid.toString(),
      });
    }
    case "RegistrationOwnerUnavailable": {
      return new RegistrationConflict({
        kind: "owner-unavailable",
        qid: error.qid.toString(),
      });
    }
    case "HandleLeaseConflict": {
      return new RegistrationConflict({ kind: "lease-conflict" });
    }
    case "RegistrationDraftLimitReached": {
      return new RegistrationConflict({ kind: "draft-limit" });
    }
    case "RegistrationIntentConflict": {
      return new RegistrationConflict({ kind: "intent-conflict" });
    }
    case "RegistrationTransitionConflict": {
      return error.actual === "expired"
        ? new RegistrationExpired({ digest: error.digest as Hash })
        : new RegistrationConflict({
            actual: error.actual,
            kind: "transition-conflict",
          });
    }
    case "RegistrationIntentExpired": {
      return new RegistrationExpired({ digest: error.digest as Hash });
    }
    case "RegistrationIntentNotFound": {
      return new RegistrationNotFound({ digest: error.digest as Hash });
    }
    case "RegistrationSignatureMismatch": {
      return error.kind === "owner"
        ? new RegistrationUnauthorized()
        : new RegistrationServiceUnavailable();
    }
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
      .handle("prepare", ({ payload }) =>
        enrollment
          .prepare({
            handle: payload.handle,
            idempotencyKey: payload.idempotencyKey,
            owner: payload.owner as Address,
            peerId: payload.peerId,
          })
          .pipe(transportErrors)
      )
      .handle("authorize", ({ params, payload }) =>
        enrollment
          .authorize({
            digest: params.digest as Hash,
            ownerSignature: payload.ownerSignature as Hex,
          })
          .pipe(transportErrors)
      )
      .handle("reconcile", ({ params }) =>
        enrollment.reconcile(params.digest as Hash).pipe(
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
