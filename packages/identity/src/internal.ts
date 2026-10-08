import { toHex } from "viem";
import type { Signature } from "viem";

// Rejects unknown object keys and reports every issue. Effect 4 no longer reads
// parse options from schema annotations, so exported struct schemas are not strict
// on their own: every decode of untrusted or persisted data must pass these.
// Frozen because one shared object backs every decoder.
export const strictParseOptions = Object.freeze({
  errors: "all",
  onExcessProperty: "error",
} as const);

export const toViemSignature = (signature: Uint8Array): Signature => ({
  r: toHex(signature.subarray(0, 32)),
  s: toHex(signature.subarray(32, 64)),
  yParity: signature[64] === 0 ? 0 : 1,
});
