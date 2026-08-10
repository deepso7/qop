import { parseAbi } from "viem";

export const registryReadAbi = parseAbi([
  "function account(uint256 qid) view returns (address owner, uint32 ownerVersion, uint64 registeredAt, uint256 nonce, string handle)",
  "function isDeviceRevoked(uint256 qid, bytes32 certificateDigest) view returns (bool)",
  "function qidByHandleHash(bytes32 handleHash) view returns (uint256)",
  "function qidByOwner(address owner) view returns (uint256)",
  "function registrationNonceUsed(bytes32 registrationNonce) view returns (bool)",
]);
