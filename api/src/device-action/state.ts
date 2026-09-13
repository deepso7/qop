import type { DeviceActionIntentStatus } from "./types.ts";

export const deviceActionTransitionSources = {
  confirm: ["ready", "submitted"],
  expire: ["ready"],
  revert: ["submitted"],
  submit: ["ready"],
} as const satisfies Record<
  string,
  readonly [DeviceActionIntentStatus, ...DeviceActionIntentStatus[]]
>;
