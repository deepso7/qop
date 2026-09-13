export const deviceActionIntentStatuses = [
  "ready",
  "submitted",
  "confirmed",
  "reverted",
  "expired",
] as const;

export type DeviceActionIntentStatus =
  (typeof deviceActionIntentStatuses)[number];

export type DeviceActionOperation = "add" | "remove";

export interface CreateDeviceActionIntent {
  readonly accountNonce: bigint;
  readonly deadline: bigint;
  readonly deviceKey: `0x${string}`;
  readonly digest: `0x${string}`;
  readonly operation: DeviceActionOperation;
  readonly owner: `0x${string}`;
  readonly ownerSignature: `0x${string}`;
  readonly qid: bigint;
}
