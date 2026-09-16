import { fetch } from "expo/fetch";

import { createDeviceActionClient } from "./device-action-client-core";

export {
  createDeviceActionClient,
  DeviceActionClientError,
} from "./device-action-client-core";
export type {
  DeviceActionSubmitInput,
  ReconciledDeviceAction,
  SubmittedDeviceAction,
} from "./device-action-client-core";

export const { get: getDeviceAction, submit: submitDeviceAction } =
  createDeviceActionClient({ fetch });
