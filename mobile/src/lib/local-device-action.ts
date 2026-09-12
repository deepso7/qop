import * as SecureStore from "expo-secure-store";

import { getDeviceAction, submitDeviceAction } from "./device-action-client";
import { createLocalDeviceAction } from "./local-device-action-core";
import { lookupDeviceKey } from "./registry";

export {
  createLocalDeviceAction,
  LocalDeviceActionError,
} from "./local-device-action-core";
export type { LocalDeviceAction } from "./local-device-action-core";

const secureStoreOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const {
  markAcknowledged,
  persistApproval,
  pollEnrollment,
  readStored: loadLocalDeviceAction,
  reconcileMembership,
  resumeInFlightAdd,
  submitAcknowledged,
} = createLocalDeviceAction({
  deviceActionClient: { get: getDeviceAction, submit: submitDeviceAction },
  registry: { lookupDeviceKey },
  secureStore: {
    get: (key) => SecureStore.getItemAsync(key, secureStoreOptions),
    set: (key, value) =>
      SecureStore.setItemAsync(key, value, secureStoreOptions),
  },
});
