import {
  Base64Url32,
  DeviceSessionChallengeV1,
  DeviceSessionProofV1,
  Hex32,
  PeerId,
  Qid,
  UnixSeconds,
} from "@qop/identity";
import { Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";

const canonical = <S extends Schema.Top>(schema: S) =>
  schema.pipe(Schema.decodeTo(schema.pipe(Schema.flip)));

const Digest = canonical(Hex32);
const Token = canonical(Base64Url32);
const Challenge = canonical(DeviceSessionChallengeV1);
const Proof = canonical(DeviceSessionProofV1);
const PeerIdString = canonical(PeerId);
const CanonicalQid = canonical(Qid);
const CanonicalUnixSeconds = canonical(UnixSeconds);
const DigestInput = Schema.String.check(
  Schema.isPattern(/^0x[0-9a-f]{64}$/iu, {
    expected: "a 32-byte 0x-prefixed digest",
  })
);

export class DeviceSessionConflictHttp extends Schema.TaggedErrorClass<DeviceSessionConflictHttp>()(
  "DeviceSessionConflict",
  {
    kind: Schema.Literals([
      "binding-mismatch",
      "challenge-consumed",
      "challenge-expired",
    ]),
  },
  { httpApiStatus: 409 }
) {}

export class DeviceSessionRejectedHttp extends Schema.TaggedErrorClass<DeviceSessionRejectedHttp>()(
  "DeviceSessionRejected",
  { reason: Schema.Literals(["not-found", "owner-version", "revoked"]) },
  { httpApiStatus: 422 }
) {}

export class DeviceSessionInvalidHttp extends Schema.TaggedErrorClass<DeviceSessionInvalidHttp>()(
  "DeviceSessionInvalid",
  {},
  { httpApiStatus: 422 }
) {}

export class DeviceSessionUnauthorizedHttp extends Schema.TaggedErrorClass<DeviceSessionUnauthorizedHttp>()(
  "DeviceSessionUnauthorized",
  {},
  { httpApiStatus: 401 }
) {}

export class DeviceSessionServiceUnavailableHttp extends Schema.TaggedErrorClass<DeviceSessionServiceUnavailableHttp>()(
  "DeviceSessionServiceUnavailable",
  {},
  { httpApiStatus: 503 }
) {}

const Errors = [
  DeviceSessionConflictHttp,
  DeviceSessionInvalidHttp,
  DeviceSessionRejectedHttp,
  DeviceSessionServiceUnavailableHttp,
  DeviceSessionUnauthorizedHttp,
] as const;

export class DeviceSessionApiGroup extends HttpApiGroup.make("deviceSessions")
  .add(
    HttpApiEndpoint.post("issueDeviceSessionChallenge", "/challenges", {
      error: Errors,
      payload: Schema.Struct({ certificateDigest: DigestInput }),
      success: Challenge,
    }),
    HttpApiEndpoint.post("authenticateDeviceSession", "/authenticate", {
      error: Errors,
      payload: Proof,
      success: Schema.Struct({
        certificateDigest: Digest,
        expiresAt: CanonicalUnixSeconds,
        peerId: PeerIdString,
        qid: CanonicalQid,
        token: Token,
      }),
    }),
    HttpApiEndpoint.post("resolveDeviceSession", "/resolve", {
      error: Errors,
      payload: Schema.Struct({ token: Token }),
      success: Schema.Struct({
        certificateDigest: Digest,
        peerId: PeerIdString,
        qid: CanonicalQid,
      }),
    })
  )
  .prefix("/v1/device-sessions")
  .annotateMerge(OpenApi.annotations({ title: "Device sessions" })) {}
