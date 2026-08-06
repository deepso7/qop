import { assert, describe, it } from "@effect/vitest";

import {
  canTransitionRegistrationIntent,
  registrationTransitionSources,
} from "../src/registration/state.ts";
import type { RegistrationTransition } from "../src/registration/state.ts";
import { registrationIntentStatuses } from "../src/registration/types.ts";
import type { RegistrationIntentStatus } from "../src/registration/types.ts";

describe("registration intent state", () => {
  it("pins the complete status vocabulary", () => {
    assert.deepStrictEqual(registrationIntentStatuses, [
      "pending_owner_signature",
      "ready",
      "submitted",
      "confirmed",
      "failed",
      "expired",
    ]);
  });

  it("allows only the intended state transitions", () => {
    assert.deepStrictEqual(registrationTransitionSources, {
      authorize: ["pending_owner_signature"],
      confirm: ["ready", "submitted"],
      expire: ["pending_owner_signature"],
      fail: ["pending_owner_signature", "ready", "submitted"],
      submit: ["ready"],
    });

    const expectedByStatus = {
      confirmed: [],
      expired: [],
      failed: [],
      pending_owner_signature: ["authorize", "expire", "fail"],
      ready: ["confirm", "fail", "submit"],
      submitted: ["confirm", "fail"],
    } as const satisfies Record<
      RegistrationIntentStatus,
      readonly RegistrationTransition[]
    >;

    for (const status of registrationIntentStatuses) {
      for (const transition of [
        "authorize",
        "confirm",
        "expire",
        "fail",
        "submit",
      ] as const) {
        assert.strictEqual(
          canTransitionRegistrationIntent(transition, status),
          expectedByStatus[status].some((expected) => expected === transition),
          `${transition} from ${status}`
        );
      }
    }
  });
});
