import type { Address, Hash, Hex } from "viem";

export const registrationIntentStatuses = [
  "ready",
  "submitted",
  "confirmed",
  "failed",
] as const;

export type RegistrationIntentStatus =
  (typeof registrationIntentStatuses)[number];

export interface CreateRegistrationIntent {
  readonly admissionCodeHash: Hash;
  readonly deadline: bigint;
  readonly deviceKey: Hash;
  readonly digest: Hash;
  readonly handle: string;
  readonly owner: Address;
  readonly ownerSignature: Hex;
  readonly registrationNonce: Hash;
  readonly registrationSignature: Hex;
}
