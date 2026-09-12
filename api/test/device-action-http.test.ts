import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import { DeviceActionEnrollment } from "../src/device-action/enrollment.ts";
import {
  DeviceActionDeadlineInvalid,
  DeviceActionInFlightConflict,
  DeviceActionIntentNotFound,
} from "../src/device-action/store.ts";
import {
  ReconciledDeviceActionResponse,
  SubmitDeviceActionPayload,
  SubmittedDeviceActionResponse,
} from "../src/http/device-action-api.ts";
import { QopHttpApiRoutes } from "../src/http/routes.ts";
import { RegistrationEnrollment } from "../src/registration/enrollment.ts";
import { RegistrationIntentNotFound } from "../src/registration/store.ts";
import { testHash, testSignature } from "./support/ethereum.ts";

const DIGEST = testHash("device-action");
const NOT_FOUND_DIGEST = testHash("not-found");
const IN_FLIGHT_DIGEST = testHash("in-flight");
const TRANSACTION_HASH = testHash("transaction");
const SIGNATURE = testSignature("00");
const intent = {
  deadline: "1700000600",
  deviceKey: testHash("device"),
  nonce: "9",
  qid: "42",
} as const;

interface DeviceActionBody {
  readonly intent: {
    readonly deadline: string;
    readonly deviceKey: string;
    readonly nonce: string;
    readonly qid: string;
  };
  readonly operation: "add";
  readonly ownerSignature: string;
}

const payload: DeviceActionBody = {
  intent,
  operation: "add",
  ownerSignature: SIGNATURE,
};

const RegistrationEnrollmentTestLive = Layer.succeed(
  RegistrationEnrollment,
  RegistrationEnrollment.of({
    reconcile: (digest) =>
      Effect.fail(new RegistrationIntentNotFound({ digest })),
    register: () =>
      Effect.succeed({
        digest: DIGEST,
        registrationSignature: SIGNATURE,
        status: "submitted" as const,
        transactionHash: TRANSACTION_HASH,
      }),
  })
);

const DeviceActionEnrollmentTestLive = Layer.succeed(
  DeviceActionEnrollment,
  DeviceActionEnrollment.of({
    reconcile: (digest) =>
      digest === NOT_FOUND_DIGEST
        ? Effect.fail(new DeviceActionIntentNotFound({ digest }))
        : Effect.succeed({
            digest,
            failureCode: null,
            status: "confirmed" as const,
            transactionHash: TRANSACTION_HASH,
          }),
    submit: (input) => {
      if (input.intent.deadline === "1") {
        return Effect.fail(new DeviceActionDeadlineInvalid({ deadline: 1n }));
      }
      if (input.intent.deviceKey === testHash("conflict")) {
        return Effect.fail(
          new DeviceActionInFlightConflict({
            digest: IN_FLIGHT_DIGEST,
            qid: 42n,
          })
        );
      }
      assert.deepStrictEqual(input, payload);
      return Effect.succeed({
        digest: DIGEST,
        status: "submitted" as const,
        transactionHash: TRANSACTION_HASH,
      });
    },
  })
);

const { handler } = HttpRouter.toWebHandler(
  QopHttpApiRoutes.pipe(
    Layer.provide(RegistrationEnrollmentTestLive),
    Layer.provide(DeviceActionEnrollmentTestLive),
    Layer.provide(HttpServer.layerServices)
  ),
  { disableLogger: true }
);

const postDeviceAction = (body: DeviceActionBody) =>
  Effect.promise(() =>
    handler(
      new Request("http://qop.test/v1/device-actions", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    )
  );

const json = <Value>(response: Response) =>
  Effect.promise(
    () =>
      // SAFETY: Each caller validates the decoded HTTP body through exact assertions.
      response.json() as Promise<Value>
  );

describe("device-action HTTP API", () => {
  it.effect("submits and reconciles using the two endpoint shapes", () =>
    Effect.gen(function* () {
      const submittedResponse = yield* postDeviceAction(payload);
      assert.deepStrictEqual(yield* json(submittedResponse), {
        digest: DIGEST,
        status: "submitted",
        transactionHash: TRANSACTION_HASH,
      });
      const reconciledResponse = yield* Effect.promise(() =>
        handler(new Request(`http://qop.test/v1/device-actions/${DIGEST}`))
      );
      assert.deepStrictEqual(yield* json(reconciledResponse), {
        digest: DIGEST,
        failureCode: null,
        status: "confirmed",
        transactionHash: TRANSACTION_HASH,
      });
    })
  );

  it.effect("maps stable device-action errors", () =>
    Effect.gen(function* () {
      const invalid = yield* postDeviceAction({
        ...payload,
        intent: { ...intent, deadline: "1" },
      });
      assert.strictEqual(invalid.status, 422);
      assert.strictEqual(
        (yield* json<{ _tag: string }>(invalid))._tag,
        "DeviceActionInvalid"
      );
      const conflict = yield* postDeviceAction({
        ...payload,
        intent: { ...intent, deviceKey: testHash("conflict") },
      });
      assert.strictEqual(conflict.status, 409);
      assert.deepStrictEqual(yield* json(conflict), {
        _tag: "DeviceActionConflict",
        digest: IN_FLIGHT_DIGEST,
        kind: "in-flight",
      });
      const notFound = yield* Effect.promise(() =>
        handler(
          new Request(`http://qop.test/v1/device-actions/${NOT_FOUND_DIGEST}`)
        )
      );
      assert.strictEqual(notFound.status, 404);
      assert.strictEqual(
        (yield* json<{ _tag: string }>(notFound))._tag,
        "DeviceActionNotFound"
      );
    })
  );

  it.effect("round-trips the public schemas", () =>
    Effect.gen(function* () {
      const submitted = {
        digest: DIGEST,
        status: "submitted",
        transactionHash: TRANSACTION_HASH,
      } as const;
      const reconciled = {
        digest: DIGEST,
        failureCode: null,
        status: "confirmed",
        transactionHash: TRANSACTION_HASH,
      } as const;
      for (const [schema, value] of [
        [SubmitDeviceActionPayload, payload],
        [SubmittedDeviceActionResponse, submitted],
        [ReconciledDeviceActionResponse, reconciled],
      ] as const) {
        const decoded = yield* Schema.decodeUnknownEffect(schema)(value);
        assert.deepStrictEqual(
          yield* Schema.encodeEffect(schema)(decoded),
          value
        );
      }
    })
  );
});
