import type { Address, Hash, Hex } from "viem";

export const registrationIntentStatuses = [
  "pending_owner_signature",
  "ready",
  "submitted",
  "confirmed",
  "failed",
  "expired",
] as const;

export type RegistrationIntentStatus =
  (typeof registrationIntentStatuses)[number];

export interface CreateRegistrationIntent {
  readonly deadline: bigint;
  readonly deviceCommitment: Hash;
  readonly digest: Hash;
  readonly handle: string;
  readonly observeTokenHash: Hash;
  readonly owner: Address;
  readonly peerId: string;
  readonly registrationNonce: Hash;
}

export interface RegistrationAuthorization {
  readonly ownerSignature: Hex;
  readonly registrationSignature: Hex;
}
