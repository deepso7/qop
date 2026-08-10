import { toHex } from "viem";
import type { Signature } from "viem";

export const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

export const toViemSignature = (signature: Uint8Array): Signature => ({
  r: toHex(signature.subarray(0, 32)),
  s: toHex(signature.subarray(32, 64)),
  yParity: signature[64] as 0 | 1,
});
