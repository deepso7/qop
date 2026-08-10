import type { RegistrationIntentStatus } from "./types.ts";

export const registrationTransitionSources = {
  authorize: ["pending_owner_signature"],
  confirm: ["ready", "submitted"],
  expire: ["pending_owner_signature"],
  fail: ["pending_owner_signature", "ready", "submitted"],
  submit: ["ready"],
} as const satisfies Record<
  string,
  readonly [RegistrationIntentStatus, ...RegistrationIntentStatus[]]
>;

export type RegistrationTransition = keyof typeof registrationTransitionSources;

export const canTransitionRegistrationIntent = (
  transition: RegistrationTransition,
  status: RegistrationIntentStatus
): boolean =>
  registrationTransitionSources[transition].some((source) => source === status);
