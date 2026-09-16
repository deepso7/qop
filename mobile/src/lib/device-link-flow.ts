import { signDeviceActionRecord } from "./device-action-approval";
import { createDeviceLinkFlow } from "./device-link-flow-core";
import {
  markAcknowledged,
  persistApproval,
  pollEnrollment,
  reconcileMembership,
  resumeInFlight,
  submitAcknowledged,
} from "./local-device-action";
import { sendPairingApproval } from "./pairing-client-core";

export { DeviceActionApprovalError } from "./device-action-approval";
export { createDeviceLinkFlow } from "./device-link-flow-core";
export type { DeviceLinkDependencies } from "./device-link-flow-core";

export const { completeDeviceLink, completeDeviceRemove } =
  createDeviceLinkFlow({
    markAcknowledged,
    persistApproval,
    pollEnrollment,
    reconcileMembership,
    resumeInFlight,
    sendPairingApproval,
    signDeviceActionRecord,
    submitAcknowledged,
  });
