import { assert, describe, it } from "@effect/vitest";

import { canTransitionRegistrationIntent } from "../src/registration/state.ts";
import type { RegistrationTransition } from "../src/registration/state.ts";
import { registrationIntentStatuses } from "../src/registration/types.ts";
import type { RegistrationIntentStatus } from "../src/registration/types.ts";

describe("registration intent state", () => {
  it("allows only the intended state transitions", () => {
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
