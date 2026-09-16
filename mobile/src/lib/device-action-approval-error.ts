import { Data } from "effect";

export class DeviceActionApprovalError extends Data.TaggedError(
  "DeviceActionApprovalError"
)<{
  readonly operation: "sign" | "snapshot";
}> {}
