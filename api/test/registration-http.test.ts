import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema, SchemaIssue } from "effect";
import { HttpClient, HttpRouter } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import type { Address, Hash, Hex } from "viem";

import { DeviceSessionService } from "../src/device-session/service.ts";
import { DeviceObservation } from "../src/device/observation.ts";
import { QopHttpApi } from "../src/http/api.ts";
import {
  AuthorizedRegistrationResponse,
  PreparedRegistrationResponse,
  PrepareRegistrationPayload,
  ReconciledRegistrationResponse,
  RegistrationConflict,
  RegistrationExpired,
  RegistrationInvalid,
  RegistrationNotFound,
  RegistrationServiceUnavailable,
  RegistrationUnauthorized,
} from "../src/http/registration-api.ts";
import { QopHttpApiRoutes } from "../src/http/routes.ts";
import { RegistrationAdmissionUnauthorized } from "../src/registration/admission.ts";
import {
  RegistrationEnrollment,
  RegistrationHandleUnavailable,
  RegistrationProtocolError,
  RegistrationSignatureMismatch,
} from "../src/registration/enrollment.ts";
import { RegistrationInputError } from "../src/registration/inputs.ts";
import {
  RegistrationIntentExpired,
  RegistrationIntentNotFound,
  RegistrationTransitionConflict,
} from "../src/registration/store.ts";

const OWNER = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf" as Address;
const CHECKSUMMED_OWNER =
  "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf" as Address;
const DIGEST =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as Hash;
const UNAUTHORIZED_DIGEST =
  "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as Hash;
const REGISTRAR_MISMATCH_DIGEST =
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Hash;
const EXPIRED_DIGEST =
  "0x3333333333333333333333333333333333333333333333333333333333333333" as Hash;
const TERMINAL_EXPIRED_DIGEST =
  "0x4444444444444444444444444444444444444444444444444444444444444444" as Hash;
const FAILED_DIGEST =
  "0x5555555555555555555555555555555555555555555555555555555555555555" as Hash;
const NOT_FOUND_DIGEST =
  "0x6666666666666666666666666666666666666666666666666666666666666666" as Hash;
const SERVICE_UNAVAILABLE_DIGEST =
  "0x7777777777777777777777777777777777777777777777777777777777777777" as Hash;
const NULL_QID_DIGEST =
  "0x8888888888888888888888888888888888888888888888888888888888888888" as Hash;
const NONCE =
  "0x2222222222222222222222222222222222222222222222222222222222222222";
const SIGNATURE = `0x${"1".padStart(64, "0")}${"1".padStart(64, "0")}00` as Hex;
const PEER_ID = "12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X";
const OBSERVE_TOKEN_HASH =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hash;
const IDEMPOTENCY_KEY = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ADMISSION_CODE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

const intent = {
  deadline: "600",
  deviceCommitment:
    "0x9999999999999999999999999999999999999999999999999999999999999999",
  handle: "alice",
  nonce: NONCE,
  owner: OWNER,
} as const;

const RegistrationEnrollmentTestLive = Layer.succeed(
  RegistrationEnrollment,
  RegistrationEnrollment.of({
    authorize: Effect.fn("test.registrationAuthorize")(function* (input) {
      if (
        input.digest === UNAUTHORIZED_DIGEST ||
        input.digest === REGISTRAR_MISMATCH_DIGEST
      ) {
        return yield* new RegistrationSignatureMismatch({
          expected: OWNER,
          kind: input.digest === UNAUTHORIZED_DIGEST ? "owner" : "registration",
          recovered: "0x0000000000000000000000000000000000000001",
        });
      }
      if (input.digest === EXPIRED_DIGEST) {
        return yield* new RegistrationIntentExpired({ digest: input.digest });
      }
      if (input.digest === TERMINAL_EXPIRED_DIGEST) {
        return yield* new RegistrationTransitionConflict({
          actual: "expired",
          digest: input.digest,
          expected: ["pending_owner_signature"],
        });
      }
      if (input.digest === FAILED_DIGEST) {
        return yield* new RegistrationTransitionConflict({
          actual: "failed",
          digest: input.digest,
          expected: ["pending_owner_signature"],
        });
      }
      if (input.digest === NOT_FOUND_DIGEST) {
        return yield* new RegistrationIntentNotFound({ digest: input.digest });
      }
      if (input.digest === SERVICE_UNAVAILABLE_DIGEST) {
        return yield* new RegistrationProtocolError({
          cause: "test failure",
          operation: "verify-state",
        });
      }
      assert.deepStrictEqual(input, {
        digest: DIGEST,
        ownerSignature: SIGNATURE,
      });
      return {
        digest: DIGEST,
        intent,
        ownerSignature: SIGNATURE,
        registrationSignature: SIGNATURE,
        status: "ready",
      };
    }),
    prepare: Effect.fn("test.registrationPrepare")(function* (input) {
      if (input.handle === "admissiondenied") {
        return yield* new RegistrationAdmissionUnauthorized({
          codeHash: DIGEST,
        });
      }
      if (input.handle === "conflict") {
        return yield* new RegistrationHandleUnavailable({
          handle: input.handle,
          qid: 9n,
        });
      }
      if (input.handle === "invalid") {
        return yield* new RegistrationInputError({
          cause: "test failure",
          field: "owner",
        });
      }
      assert.deepStrictEqual(input, {
        admissionCode: ADMISSION_CODE,
        deviceCommitment: intent.deviceCommitment,
        handle: "alice",
        idempotencyKey: IDEMPOTENCY_KEY,
        observeTokenHash: OBSERVE_TOKEN_HASH,
        owner: CHECKSUMMED_OWNER,
        peerId: PEER_ID,
      });
      return {
        digest: DIGEST,
        intent,
        status: "pending_owner_signature",
      };
    }),
    reconcile: (digest) =>
      Effect.sync(() => {
        if (digest === NULL_QID_DIGEST) {
          return {
            digest,
            failureCode: null,
            qid: null,
            status: "ready" as const,
          };
        }
        assert.strictEqual(digest, DIGEST);
        return {
          digest: DIGEST,
          failureCode: null,
          qid: 42n,
          status: "confirmed" as const,
        };
      }),
  })
);

const DeviceObservationUnusedTestLive = Layer.succeed(
  DeviceObservation,
  DeviceObservation.of({
    observeFromRegistration: () =>
      Effect.die("device observation is not used by registration HTTP tests"),
  })
);

const DeviceSessionUnusedTestLive = Layer.succeed(
  DeviceSessionService,
  DeviceSessionService.of({
    authenticate: () => Effect.die("not used by registration HTTP tests"),
    issue: () => Effect.die("not used by registration HTTP tests"),
    resolve: () => Effect.die("not used by registration HTTP tests"),
  })
);

const ApiRoutesTestLive = HttpRouter.serve(
  QopHttpApiRoutes.pipe(
    Layer.provide(DeviceObservationUnusedTestLive),
    Layer.provide(DeviceSessionUnusedTestLive),
    Layer.provide(RegistrationEnrollmentTestLive)
  ),
  { disableListenLog: true, disableLogger: true }
).pipe(Layer.provideMerge(NodeHttpServer.layerTest));

describe("registration HTTP API", () => {
  it.effect("prepares, authorizes, and reconciles registrations", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(QopHttpApi);
      const prepared = yield* client.registrations.prepare({
        payload: {
          admissionCode: ADMISSION_CODE,
          deviceCommitment: intent.deviceCommitment,
          handle: "alice",
          idempotencyKey: IDEMPOTENCY_KEY,
          observeTokenHash: OBSERVE_TOKEN_HASH,
          owner: CHECKSUMMED_OWNER,
          peerId: PEER_ID,
        },
      });
      assert.strictEqual(prepared.digest, DIGEST);
      assert.strictEqual(prepared.intent.owner, OWNER);

      const authorized = yield* client.registrations.authorize({
        params: { digest: DIGEST },
        payload: { ownerSignature: SIGNATURE },
      });
      assert.strictEqual(authorized.status, "ready");
      assert.strictEqual(authorized.registrationSignature, SIGNATURE);

      const reconciled = yield* client.registrations.reconcile({
        params: { digest: DIGEST },
      });
      assert.strictEqual(reconciled.status, "confirmed");
      assert.strictEqual(reconciled.qid, "42");
    }).pipe(Effect.provide(ApiRoutesTestLive))
  );

  it.effect("mounts the production routes and OpenAPI document", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/openapi.json");
      assert.strictEqual(response.status, 200);
      const document = (yield* response.json) as {
        readonly paths: Readonly<Record<string, unknown>>;
      };
      assert.hasAllKeys(document.paths, [
        "/v1/device-sessions/authenticate",
        "/v1/device-sessions/challenges",
        "/v1/device-sessions/resolve",
        "/v1/devices/observe",
        "/v1/registrations",
        "/v1/registrations/{digest}/authorize",
        "/v1/registrations/{digest}/reconcile",
      ]);
    }).pipe(Effect.provide(ApiRoutesTestLive))
  );

  it.effect("maps owner-proof failures to a stable unauthorized response", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(QopHttpApi);
      const error = yield* client.registrations
        .authorize({
          params: { digest: UNAUTHORIZED_DIGEST },
          payload: { ownerSignature: SIGNATURE },
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, RegistrationUnauthorized);
    }).pipe(Effect.provide(ApiRoutesTestLive))
  );

  it.effect("maps admission denial through the mounted HTTP transport", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(QopHttpApi);
      const error = yield* client.registrations
        .prepare({
          payload: {
            admissionCode: ADMISSION_CODE,
            deviceCommitment: intent.deviceCommitment,
            handle: "admissiondenied",
            idempotencyKey: IDEMPOTENCY_KEY,
            observeTokenHash: OBSERVE_TOKEN_HASH,
            owner: CHECKSUMMED_OWNER,
            peerId: PEER_ID,
          },
        })
        .pipe(Effect.flip);
      assert.instanceOf(error, RegistrationUnauthorized);
    }).pipe(Effect.provide(ApiRoutesTestLive))
  );

  it.effect(
    "does not misreport registrar failures as owner authentication",
    () =>
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(QopHttpApi);
        const error = yield* client.registrations
          .authorize({
            params: { digest: REGISTRAR_MISMATCH_DIGEST },
            payload: { ownerSignature: SIGNATURE },
          })
          .pipe(Effect.flip);

        assert.instanceOf(error, RegistrationServiceUnavailable);
      }).pipe(Effect.provide(ApiRoutesTestLive))
  );

  it.effect("preserves conflict and terminal registration state", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(QopHttpApi);
      const conflict = yield* client.registrations
        .prepare({
          payload: {
            admissionCode: ADMISSION_CODE,
            deviceCommitment: intent.deviceCommitment,
            handle: "conflict",
            idempotencyKey: IDEMPOTENCY_KEY,
            observeTokenHash: OBSERVE_TOKEN_HASH,
            owner: CHECKSUMMED_OWNER,
            peerId: PEER_ID,
          },
        })
        .pipe(Effect.flip);
      assert.instanceOf(conflict, RegistrationConflict);
      assert.strictEqual(conflict.kind, "handle-unavailable");
      assert.strictEqual(conflict.qid, "9");

      const failed = yield* client.registrations
        .authorize({
          params: { digest: FAILED_DIGEST },
          payload: { ownerSignature: SIGNATURE },
        })
        .pipe(Effect.flip);
      assert.instanceOf(failed, RegistrationConflict);
      assert.strictEqual(failed.kind, "transition-conflict");
      assert.strictEqual(failed.actual, "failed");

      for (const digest of [EXPIRED_DIGEST, TERMINAL_EXPIRED_DIGEST]) {
        const expired = yield* client.registrations
          .authorize({
            params: { digest },
            payload: { ownerSignature: SIGNATURE },
          })
          .pipe(Effect.flip);
        assert.instanceOf(expired, RegistrationExpired);
        assert.strictEqual(expired.digest, digest);
      }
    }).pipe(Effect.provide(ApiRoutesTestLive))
  );

  it.effect("maps not-found, invalid, and internal failures", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(QopHttpApi);
      const notFound = yield* client.registrations
        .authorize({
          params: { digest: NOT_FOUND_DIGEST },
          payload: { ownerSignature: SIGNATURE },
        })
        .pipe(Effect.flip);
      assert.instanceOf(notFound, RegistrationNotFound);

      const invalid = yield* client.registrations
        .prepare({
          payload: {
            admissionCode: ADMISSION_CODE,
            deviceCommitment: intent.deviceCommitment,
            handle: "invalid",
            idempotencyKey: IDEMPOTENCY_KEY,
            observeTokenHash: OBSERVE_TOKEN_HASH,
            owner: CHECKSUMMED_OWNER,
            peerId: PEER_ID,
          },
        })
        .pipe(Effect.flip);
      assert.instanceOf(invalid, RegistrationInvalid);

      const unavailable = yield* client.registrations
        .authorize({
          params: { digest: SERVICE_UNAVAILABLE_DIGEST },
          payload: { ownerSignature: SIGNATURE },
        })
        .pipe(Effect.flip);
      assert.instanceOf(unavailable, RegistrationServiceUnavailable);
    }).pipe(Effect.provide(ApiRoutesTestLive))
  );

  it.effect("serializes an unresolved reconciliation qid as null", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(QopHttpApi);
      const reconciled = yield* client.registrations.reconcile({
        params: { digest: NULL_QID_DIGEST },
      });

      assert.strictEqual(reconciled.status, "ready");
      assert.isNull(reconciled.qid);
    }).pipe(Effect.provide(ApiRoutesTestLive))
  );

  it.effect("round-trips and pins identity codecs at the HTTP boundary", () =>
    Effect.gen(function* () {
      const preparePayload = {
        admissionCode: ADMISSION_CODE,
        deviceCommitment: intent.deviceCommitment,
        handle: "alice",
        idempotencyKey: IDEMPOTENCY_KEY,
        observeTokenHash: OBSERVE_TOKEN_HASH,
        owner: OWNER,
        peerId: PEER_ID,
      } as const;
      const preparedResponse = {
        digest: DIGEST,
        intent,
        status: "pending_owner_signature",
      } as const;
      const authorizedResponse = {
        digest: DIGEST,
        intent,
        ownerSignature: SIGNATURE,
        registrationSignature: SIGNATURE,
        status: "ready",
      } as const;
      const reconciledResponse = {
        digest: DIGEST,
        failureCode: null,
        qid: "42",
        status: "confirmed",
      } as const;

      for (const [schema, value] of [
        [PrepareRegistrationPayload, preparePayload],
        [PreparedRegistrationResponse, preparedResponse],
        [AuthorizedRegistrationResponse, authorizedResponse],
        [ReconciledRegistrationResponse, reconciledResponse],
      ] as const) {
        const decoded = yield* Schema.decodeUnknownEffect(schema)(value);
        assert.deepStrictEqual(
          yield* Schema.encodeEffect(schema)(decoded),
          value
        );
      }

      const highSignature = `0x${"1".padStart(64, "0")}${"f".repeat(64)}00`;
      const badObserveTokenHash = `0x${"a".repeat(63)}z`;
      const failures = yield* Effect.all([
        Schema.encodeEffect(AuthorizedRegistrationResponse)({
          digest: DIGEST,
          intent,
          ownerSignature: highSignature,
          registrationSignature: SIGNATURE,
          status: "ready",
        }).pipe(Effect.flip),
        Schema.decodeUnknownEffect(PrepareRegistrationPayload)({
          ...preparePayload,
          observeTokenHash: badObserveTokenHash,
        }).pipe(Effect.flip),
        Schema.decodeUnknownEffect(PrepareRegistrationPayload)({
          ...preparePayload,
          deviceCommitment: `0x${"00".repeat(32)}`,
        }).pipe(Effect.flip),
        Schema.encodeEffect(ReconciledRegistrationResponse)({
          digest: DIGEST,
          failureCode: null,
          qid: "0",
          status: "confirmed",
        }).pipe(Effect.flip),
        Schema.decodeUnknownEffect(PrepareRegistrationPayload)({
          admissionCode: ADMISSION_CODE,
          deviceCommitment: intent.deviceCommitment,
          handle: "alice",
          idempotencyKey: IDEMPOTENCY_KEY,
          observeTokenHash: OBSERVE_TOKEN_HASH,
          owner: OWNER,
          peerId: "1".repeat(52),
        }).pipe(Effect.flip),
        Schema.encodeEffect(PreparedRegistrationResponse)({
          digest: DIGEST,
          intent: {
            ...intent,
            deadline: "18446744073709551616",
          },
          status: "pending_owner_signature",
        }).pipe(Effect.flip),
        Schema.encodeEffect(AuthorizedRegistrationResponse)({
          digest: DIGEST,
          intent: {
            ...intent,
            deadline: "18446744073709551616",
          },
          ownerSignature: SIGNATURE,
          registrationSignature: SIGNATURE,
          status: "ready",
        }).pipe(Effect.flip),
      ]);

      const expected = [
        {
          message:
            "Expected an ECDSA signature with valid r, low-s, and yParity 0 or 1",
          path: ["ownerSignature"],
        },
        {
          message: "Expected a 32-byte 0x-prefixed digest",
          path: ["observeTokenHash"],
        },
        {
          message: "Expected a non-zero device commitment",
          path: ["deviceCommitment"],
        },
        { message: "Expected a positive uint256 qid", path: ["qid"] },
        {
          message: "Expected canonical MiniP2P Ed25519 PeerId bytes",
          path: ["peerId"],
        },
        {
          message: "Expected a uint64 Unix timestamp",
          path: ["intent", "deadline"],
        },
        {
          message: "Expected a uint64 Unix timestamp",
          path: ["intent", "deadline"],
        },
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
