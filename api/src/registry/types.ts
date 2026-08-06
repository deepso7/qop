import type { Address } from "viem";

export interface RegistryAccount {
  readonly handle: string;
  readonly nonce: bigint;
  readonly owner: Address;
  readonly ownerVersion: number;
  readonly qid: bigint;
  readonly registeredAt: bigint;
}

export interface RegistrySnapshot<Value> {
  readonly blockNumber: bigint;
  readonly value: Value;
}
