import * as Crypto from "expo-crypto";
import { File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";

import { createIdentityVault } from "./identity-vault-core";

export { createIdentityVault, IdentityVaultError } from "./identity-vault-core";
export type {
  IdentityBackupState,
  IdentityVaultDependencies,
  LocalIdentity,
} from "./identity-vault-core";

const secureStoreOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const {
  createLocalIdentity,
  deleteLocalIdentity,
  loadDeviceSecretKey,
  loadLocalIdentity,
  revealLocalIdentityRecoveryKey,
  signRegisterIntent,
  updateLocalIdentityBackupState,
} = createIdentityVault({
  makeInstallMarker: () => new File(Paths.document, ".qop-install-v1"),
  randomBytes: () => Crypto.getRandomBytesAsync(32),
  secureStore: {
    delete: (key) => SecureStore.deleteItemAsync(key, secureStoreOptions),
    get: (key) => SecureStore.getItemAsync(key, secureStoreOptions),
    isAvailable: () => SecureStore.isAvailableAsync(),
    set: (key, value) =>
      SecureStore.setItemAsync(key, value, secureStoreOptions),
  },
});
