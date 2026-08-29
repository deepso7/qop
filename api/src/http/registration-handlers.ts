import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type { Hash } from "viem";

import type { RegistrationEnrollmentError } from "../registration/enrollment.ts";
import { RegistrationEnrollment } from "../registration/enrollment.ts";
import {
  normalizeDeviceCommitment,
  normalizeRegistrationDigest,
  normalizeRegistrationObserveTokenHash,
  normalizeRegistrationOwner,
  normalizeRegistrationOwnerSignature,
} from "../registration/inputs.ts";
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
    case "RegistrationAdmissionUnauthorized": {
      return new RegistrationUnauthorized();
    }
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
    case "RegistrationAdmissionDraftLimitReached": {
      return new RegistrationConflict({ kind: "admission-draft-limit" });
    }
    case "RegistrationIntentConflict": {
      return new RegistrationConflict({ kind: "intent-conflict" });
    }
    case "RegistrationTransitionConflict": {
      // SAFETY: Registration transitions originate from a stored intent whose digest column is a Hash.
      return error.actual === "expired"
        ? new RegistrationExpired({ digest: error.digest as Hash })
        : new RegistrationConflict({
            actual: error.actual,
            kind: "transition-conflict",
          });
    }
    case "RegistrationIntentExpired": {
      // SAFETY: A registration intent stores its digest in a Hash-typed database column.
      return new RegistrationExpired({ digest: error.digest as Hash });
    }
    case "RegistrationIntentNotFound": {
      // SAFETY: Lookup errors carry the caller's digest after RegistrationEnrollment normalizes it.
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
        Effect.all({
          deviceCommitment: normalizeDeviceCommitment(payload.deviceCommitment),
          observeTokenHash: normalizeRegistrationObserveTokenHash(
            payload.observeTokenHash
          ),
          owner: normalizeRegistrationOwner(payload.owner),
        }).pipe(
          Effect.flatMap((normalized) =>
            enrollment.prepare({ ...payload, ...normalized })
          ),
          transportErrors
        )
      )
      .handle("authorize", ({ params, payload }) =>
        Effect.all({
          digest: normalizeRegistrationDigest(params.digest),
          ownerSignature: normalizeRegistrationOwnerSignature(
            payload.ownerSignature
          ),
        }).pipe(
          Effect.flatMap((normalized) => enrollment.authorize(normalized)),
          transportErrors
        )
      )
      .handle("reconcile", ({ params }) =>
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
