import { randomInt } from "node:crypto";

import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";

import {
  decodeRegistrationAdmissionCode,
  RegistrationAdmission,
  RegistrationAdmissionLive,
} from "./registration/admission.ts";

Effect.gen(function* () {
  const admissions = yield* RegistrationAdmission;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  while (true) {
    const compact = Array.from({ length: 6 }, () =>
      alphabet.charAt(randomInt(alphabet.length))
    ).join("");
    const code = `${compact.slice(0, 3)}-${compact.slice(3)}`;
    const decoded = yield* decodeRegistrationAdmissionCode(code);
    if (yield* admissions.create(decoded.codeHash)) {
      yield* Effect.sync(() => console.log(code));
      return;
    }
  }
}).pipe(Effect.provide(RegistrationAdmissionLive), NodeRuntime.runMain);
