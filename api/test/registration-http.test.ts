import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema, SchemaIssue } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import {
  ReconciledRegistrationResponse,
  RegisteredRegistrationResponse,
  RegisterRegistrationPayload,
} from "../src/http/registration-api.ts";
import { QopHttpApiRoutes } from "../src/http/routes.ts";
import {
  RegistrationDeadlineInvalid,
  RegistrationEnrollment,
  RegistrationNonceUsed,
  RegistrationSignatureMismatch,
} from "../src/registration/enrollment.ts";
import { RegistrationIntentNotFound } from "../src/registration/store.ts";
import { testAddress, testHash, testSignature } from "./support/ethereum.ts";

const OWNER = testAddress("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
const DIGEST = testHash("registration");
const NOT_FOUND_DIGEST = testHash("not-found");
const TRANSACTION_HASH = testHash("transaction");
const SIGNATURE = testSignature("00");
const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();
const intent = {
  deadline: "600",
  deviceKey: testHash("device"),
  handle: "alice",
  nonce: testHash("nonce"),
  owner: OWNER,
} as const;
const payload = {
  admissionCode: "ABC-123",
  intent,
  ownerSignature: SIGNATURE,
} as const;

const RegistrationEnrollmentTestLive = Layer.succeed(
  RegistrationEnrollment,
  RegistrationEnrollment.of({
    reconcile: (digest) =>
      digest === NOT_FOUND_DIGEST
        ? Effect.fail(new RegistrationIntentNotFound({ digest }))
        : Effect.succeed({
            digest,
            failureCode: null,
            qid: 42n,
            status: "confirmed" as const,
            transactionHash: TRANSACTION_HASH,
          }),
    register: (input) => {
      if (input.intent.handle === "unauthorized") {
        return Effect.fail(
          new RegistrationSignatureMismatch({
            expected: OWNER,
            kind: "owner",
            recovered: testAddress(
              "0x0000000000000000000000000000000000000001"
            ),
          })
        );
      }
      if (input.intent.handle === "invalid") {
        return Effect.fail(new RegistrationDeadlineInvalid({ deadline: 0n }));
      }
      if (input.intent.handle === "nonceused") {
        return Effect.fail(new RegistrationNonceUsed({ nonce: DIGEST }));
      }
      assert.deepStrictEqual(input, payload);
      return Effect.succeed({
        digest: DIGEST,
        registrationSignature: SIGNATURE,
        status: "submitted" as const,
        transactionHash: TRANSACTION_HASH,
      });
    },
  })
);

const { handler } = HttpRouter.toWebHandler(
  QopHttpApiRoutes.pipe(
    Layer.provide(RegistrationEnrollmentTestLive),
    Layer.provide(HttpServer.layerServices)
  ),
  { disableLogger: true }
);

interface RegistrationBody {
  readonly admissionCode: string;
  readonly intent: {
    readonly deadline: string;
    readonly deviceKey: string;
    readonly handle: string;
    readonly nonce: string;
    readonly owner: string;
  };
  readonly ownerSignature: string;
}

const postRegistration = (body: RegistrationBody) =>
  Effect.promise(() =>
    handler(
      new Request("http://qop.test/v1/registrations", {
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

describe("registration HTTP API", () => {
  it.effect("registers and reconciles using the two endpoint shapes", () =>
    Effect.gen(function* () {
      const registeredResponse = yield* postRegistration(payload);
      assert.deepStrictEqual(yield* json(registeredResponse), {
        digest: DIGEST,
        registrationSignature: SIGNATURE,
        status: "submitted",
        transactionHash: TRANSACTION_HASH,
      });
      const reconciledResponse = yield* Effect.promise(() =>
        handler(new Request(`http://qop.test/v1/registrations/${DIGEST}`))
      );
      assert.deepStrictEqual(yield* json(reconciledResponse), {
        digest: DIGEST,
        failureCode: null,
        qid: "42",
        status: "confirmed",
        transactionHash: TRANSACTION_HASH,
      });
    })
  );

  it.effect("publishes only the two registration paths", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        handler(new Request("http://qop.test/openapi.json"))
      );
      const document = yield* json<{ paths: object }>(response);
      assert.sameMembers(Object.keys(document.paths), [
        "/v1/registrations",
        "/v1/registrations/{digest}",
      ]);
    })
  );

  it.effect("maps stable registration errors", () =>
    Effect.gen(function* () {
      const call = (handle: string) =>
        postRegistration({ ...payload, intent: { ...intent, handle } });

      const unauthorized = yield* call("unauthorized");
      assert.strictEqual(unauthorized.status, 401);
      assert.strictEqual(
        (yield* json<{ _tag: string }>(unauthorized))._tag,
        "RegistrationUnauthorized"
      );
      const invalid = yield* call("invalid");
      assert.strictEqual(invalid.status, 422);
      assert.strictEqual(
        (yield* json<{ _tag: string }>(invalid))._tag,
        "RegistrationInvalid"
      );
      const conflict = yield* call("nonceused");
      assert.strictEqual(conflict.status, 409);
      assert.deepStrictEqual(yield* json(conflict), {
        _tag: "RegistrationConflict",
        kind: "nonce-used",
      });
      const notFound = yield* Effect.promise(() =>
        handler(
          new Request(`http://qop.test/v1/registrations/${NOT_FOUND_DIGEST}`)
        )
      );
      assert.strictEqual(notFound.status, 404);
      assert.strictEqual(
        (yield* json<{ _tag: string }>(notFound))._tag,
        "RegistrationNotFound"
      );
    })
  );

  it.effect("round-trips the public schemas", () =>
    Effect.gen(function* () {
      const registered = {
        digest: DIGEST,
        registrationSignature: SIGNATURE,
        status: "submitted",
        transactionHash: TRANSACTION_HASH,
      } as const;
      const reconciled = {
        digest: DIGEST,
        failureCode: null,
        qid: "42",
        status: "confirmed",
        transactionHash: TRANSACTION_HASH,
      } as const;

      for (const [schema, value] of [
        [RegisterRegistrationPayload, payload],
        [RegisteredRegistrationResponse, registered],
        [ReconciledRegistrationResponse, reconciled],
      ] as const) {
        const decoded = yield* Schema.decodeUnknownEffect(schema)(value);
        assert.deepStrictEqual(
          yield* Schema.encodeEffect(schema)(decoded),
          value
        );
      }

      const highSignature = `0x${"1".padStart(64, "0")}${"f".repeat(64)}00`;
      const failures = yield* Effect.all([
        Schema.decodeUnknownEffect(RegisterRegistrationPayload)({
          ...payload,
          admissionCode: "X1-YT3",
        }).pipe(Effect.flip),
        Schema.decodeUnknownEffect(RegisterRegistrationPayload)({
          ...payload,
          intent: { ...intent, deviceKey: `0x${"00".repeat(32)}` },
        }).pipe(Effect.flip),
        Schema.encodeEffect(RegisteredRegistrationResponse)({
          ...registered,
          registrationSignature: highSignature,
        }).pipe(Effect.flip),
        Schema.encodeEffect(ReconciledRegistrationResponse)({
          ...reconciled,
          qid: "0",
        }).pipe(Effect.flip),
      ]);

      const expected = [
        {
          message:
            "Expected six letters or digits, optionally separated after three characters",
          path: ["admissionCode"],
        },
        {
          message: "Expected a non-zero device key",
          path: ["intent", "deviceKey"],
        },
        {
          message:
            "Expected an ECDSA signature with valid r, low-s, and yParity 0 or 1",
          path: ["registrationSignature"],
        },
        { message: "Expected a positive uint256 qid", path: ["qid"] },
      ];
      for (const [index, failure] of failures.entries()) {
        const expectedIssue = expected[index];
        if (!expectedIssue) {
          throw new Error(`Missing expected codec issue at index ${index}`);
        }
        assert.deepStrictEqual(formatIssue(failure.issue).issues, [
          expectedIssue,
        ]);
      }
    })
  );
});
