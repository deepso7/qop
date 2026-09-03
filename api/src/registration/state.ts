import type { RegistrationIntentStatus } from "./types.ts";

export const registrationTransitionSources = {
  confirm: ["ready", "submitted"],
  fail: ["ready", "submitted"],
  submit: ["ready"],
} as const satisfies Record<
  string,
  readonly [RegistrationIntentStatus, ...RegistrationIntentStatus[]]
>;

export type RegistrationTransition = keyof typeof registrationTransitionSources;
