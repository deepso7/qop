import { deleteAll } from "./db";
import { createIdentityStore } from "./identity-store-core";
import {
  createLocalIdentity,
  deleteLocalIdentity,
  IdentityVaultError,
  loadLocalIdentity,
  revealLocalIdentityRecoveryKey,
  updateLocalIdentityBackupState,
} from "./identity-vault";
import {
  deleteLocalRegistration,
  loadLocalRegistration,
} from "./local-registration";

export { createIdentityStore } from "./identity-store-core";
export type {
  IdentityStatus,
  IdentityStoreDependencies,
} from "./identity-store-core";

export const useIdentityStore = createIdentityStore({
  deleteAllData: deleteAll,
  identityVault: {
    createLocalIdentity,
    deleteLocalIdentity,
    loadLocalIdentity,
    revealLocalIdentityRecoveryKey,
    updateLocalIdentityBackupState,
  },
  makeIdentityVaultError: (operation) => new IdentityVaultError({ operation }),
  registration: { deleteLocalRegistration, loadLocalRegistration },
});
