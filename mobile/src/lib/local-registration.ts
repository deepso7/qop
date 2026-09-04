import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

import { loadLocalIdentity, signRegisterIntent } from "./identity-vault";
import { createLocalRegistration } from "./local-registration-core";
import { getRegistration, register } from "./registration-client";
import { lookupHandle, lookupOwner } from "./registry";

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
  checkLocalRegistration,
  deleteLocalRegistration,
  loadLocalRegistration,
  startLocalRegistration,
} = createLocalRegistration({
  domain: {
    chainId: process.env.EXPO_PUBLIC_REGISTRY_CHAIN_ID ?? "",
    verifyingContract: process.env.EXPO_PUBLIC_REGISTRY_ADDRESS ?? "",
  },
  now: () => BigInt(Math.floor(Date.now() / 1000)),
  randomBytes: () => Crypto.getRandomBytesAsync(32),
  registrationClient: { getRegistration, register },
  registry: { lookupHandle, lookupOwner },
  secureStore: {
    delete: (key) => SecureStore.deleteItemAsync(key, secureStoreOptions),
    get: (key) => SecureStore.getItemAsync(key, secureStoreOptions),
    set: (key, value) =>
      SecureStore.setItemAsync(key, value, secureStoreOptions),
  },
  vault: { loadLocalIdentity, signRegisterIntent },
});
