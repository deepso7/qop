import { concatHex, getAddress, keccak256, stringToHex } from "viem";
import type { Address, Hash, Hex } from "viem";

export const testAddress = (value: string): Address => {
  getAddress(value);
  return `0x${value.slice(2)}`;
};

export const testHash = (value: string | number): Hash =>
  keccak256(stringToHex(String(value)));

export const testSignature = (recovery: "00" | "01" | "1B" | "1C"): Hex =>
  concatHex([
    `0x${"1".padStart(64, "0")}`,
    `0x${"1".padStart(64, "0")}`,
    `0x${recovery}`,
  ]);

export const uppercaseHash = (hash: Hash): Hash =>
  `0x${hash.slice(2).toUpperCase()}`;

export const lowercaseHash = (hash: Hash): Hash =>
  `0x${hash.slice(2).toLowerCase()}`;
