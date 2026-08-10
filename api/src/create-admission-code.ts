import { randomBytes } from "node:crypto";

import { NodeRuntime } from "@effect/platform-node";
import { Base64Url32 } from "@qop/identity";
import { Effect, Schema } from "effect";

import {
  decodeRegistrationAdmissionCode,
  RegistrationAdmission,
  RegistrationAdmissionLive,
} from "./registration/admission.ts";

Effect.gen(function* () {
  const admissions = yield* RegistrationAdmission;
  const code = yield* Schema.encodeEffect(Base64Url32)(randomBytes(32));
  const decoded = yield* decodeRegistrationAdmissionCode(code);
  yield* admissions.create(decoded.codeHash);
  yield* Effect.sync(() => console.log(code));
}).pipe(Effect.provide(RegistrationAdmissionLive), NodeRuntime.runMain);
