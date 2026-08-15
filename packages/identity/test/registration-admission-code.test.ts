import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { RegistrationAdmissionCode } from "../src/index.ts";

describe("registration admission codes", () => {
  it.effect("normalizes six-character invitations", () =>
    Effect.gen(function* () {
      for (const input of ["X1W-YT3", "x1w-yt3", "x1wyt3"]) {
        const code = yield* Schema.decodeUnknownEffect(
          RegistrationAdmissionCode
        )(input);
        assert.strictEqual(code, "X1W-YT3");
        assert.strictEqual(
          yield* Schema.encodeEffect(RegistrationAdmissionCode)(code),
          "X1W-YT3"
        );
      }
    })
  );

  it.effect("rejects malformed invitations", () =>
    Effect.gen(function* () {
      for (const input of ["X1-YT3", "X1W--YT3", "X1W_YT3", "X1W-YT34"]) {
        assert.strictEqual(
          (yield* Schema.decodeUnknownEffect(RegistrationAdmissionCode)(
            input
          ).pipe(Effect.result))._tag,
          "Failure"
        );
      }
    })
  );
});
