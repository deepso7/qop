import { deleteAll } from "./db";
import { createIdentityStore } from "./identity-store-core";
import {
  createLocalIdentity,
  deleteLocalIdentity,
  IdentityVaultError,
  importLocalIdentity,
  loadLocalIdentity,
  revealLocalIdentityRecoveryKey,
  updateLocalIdentityBackupState,
} from "./identity-vault";
import { deleteLocalEnrollment, loadLocalEnrollment } from "./local-enrollment";
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
  enrollment: { deleteLocalEnrollment, loadLocalEnrollment },
  identityVault: {
    createLocalIdentity,
    deleteLocalIdentity,
    importLocalIdentity,
    loadLocalIdentity,
    revealLocalIdentityRecoveryKey,
    updateLocalIdentityBackupState,
  },
  makeIdentityVaultError: (operation) => new IdentityVaultError({ operation }),
  registration: { deleteLocalRegistration, loadLocalRegistration },
  stopP2p: async () => {
    const { useP2pStore } = await import("./p2p-store");
    await useP2pStore.getState().stop();
  },
});
