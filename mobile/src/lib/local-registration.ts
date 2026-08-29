import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

import {
  loadLocalIdentity,
  signLocalRegistrationIntent,
} from "./identity-vault";
import { createLocalRegistration } from "./local-registration-core";
import {
  authorizeRegistration,
  prepareRegistration,
  reconcileRegistration,
} from "./registration-client";

export {
  createLocalRegistration,
  LocalRegistrationError,
} from "./local-registration-core";
export type {
  LocalRegistration,
  LocalRegistrationDependencies,
} from "./local-registration-core";

const secureStoreOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const {
  deleteLocalRegistration,
  loadLocalRegistration,
  reconcileLocalRegistration,
  startLocalRegistration,
} = createLocalRegistration({
  randomBytes: () => Crypto.getRandomBytesAsync(32),
  registrationClient: {
    authorizeRegistration,
    prepareRegistration,
    reconcileRegistration,
  },
  secureStore: {
    delete: (key) => SecureStore.deleteItemAsync(key, secureStoreOptions),
    get: (key) => SecureStore.getItemAsync(key, secureStoreOptions),
    set: (key, value) =>
      SecureStore.setItemAsync(key, value, secureStoreOptions),
  },
  vault: {
    loadLocalIdentity,
    signLocalRegistrationIntent,
  },
});
