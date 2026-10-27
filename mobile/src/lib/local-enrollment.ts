import * as SecureStore from "expo-secure-store";

import { getDeviceAction, submitDeviceAction } from "./device-action-client";
import { loadLocalIdentity, signOwnAddDeviceIntent } from "./identity-vault";
import { createLocalEnrollment } from "./local-enrollment-core";
import { latestTimestamp, lookupOwner } from "./registry";

export {
  createLocalEnrollment,
  LocalEnrollmentError,
  MAX_DEVICES,
} from "./local-enrollment-core";

export type {
  LocalEnrollment,
  LocalEnrollmentDependencies,
  RecoveryAccount,
} from "./local-enrollment-core";

const secureStoreOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const {
  checkLocalEnrollment,
  deleteLocalEnrollment,
  findRecoveryAccount,
  loadLocalEnrollment,
  startLocalEnrollment,
} = createLocalEnrollment({
  deviceActionClient: { get: getDeviceAction, submit: submitDeviceAction },
  domain: {
    chainId: process.env.EXPO_PUBLIC_REGISTRY_CHAIN_ID ?? "",
    verifyingContract: process.env.EXPO_PUBLIC_REGISTRY_ADDRESS ?? "",
  },
  registry: { latestTimestamp, lookupOwner },
  secureStore: {
    delete: (key) => SecureStore.deleteItemAsync(key, secureStoreOptions),
    get: (key) => SecureStore.getItemAsync(key, secureStoreOptions),
    set: (key, value) =>
      SecureStore.setItemAsync(key, value, secureStoreOptions),
  },
  vault: { loadLocalIdentity, signOwnAddDeviceIntent },
});
