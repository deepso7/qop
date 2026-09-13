import { toHex } from "viem";

/** Normalize schema Type values that may be encoded strings or decoded bytes. */
export const asHex = (value: string | Uint8Array) =>
  value instanceof Uint8Array ? toHex(value) : value.toLowerCase();

export const asQidString = (value: bigint | string) => value.toString();
