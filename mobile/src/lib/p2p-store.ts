import { Minip2p, bindAppState } from "@minip2p/react-native";
import { randomUUID } from "expo-crypto";
import { registerTaskAsync } from "expo-notifications";
import { isTaskRegisteredAsync } from "expo-task-manager";
import { AppState } from "react-native";

import {
  selectAccount,
  selectIdentity,
  useIdentityStore,
} from "./identity-store";
import { loadDeviceSecretKey } from "./identity-vault";
import {
  mailboxPushEnabled,
  MAILBOX_TASK,
  notifyMailboxDelivered,
} from "./mailbox-notification";
import { loadMailboxPushKey, saveMailboxPushKey } from "./mailbox-push-key";
import { performSend } from "./p2p-send";
import { createP2pStore } from "./p2p-store-core";
import { performCatchup, performHandoff, performPoll } from "./p2p-sync";
import {
  listActiveDevices,
  lookupDeviceKey,
  lookupHandle,
  lookupQid,
} from "./registry";

export const useP2pStore = createP2pStore({
  createEndpoint: (options) => {
    const endpoint = Minip2p.create(options);

    return { bindAppState: () => bindAppState(endpoint), endpoint };
  },
  getIdentityHandle: () => selectIdentity(useIdentityStore.getState())?.handle,
  getOwnDevice: () => {
    // Set once this phone belongs to its account, whether it registered the
    // account or was restored onto it.
    const account = selectAccount(useIdentityStore.getState());

    if (!account) {
      return;
    }

    const { identity, qid } = account;

    return {
      deviceKey: identity.deviceKey,
      handle: identity.handle,
      peerId: identity.peerId,
      qid,
    };
  },
  listActiveDevices,
  loadDeviceSecretKey,
  lookupDeviceKey,
  lookupHandle,
  lookupQid,
  mailboxPush: {
    canWake: () => {
      const { status } = useIdentityStore.getState();

      return mailboxPushEnabled && (status === "loading" || status === "ready");
    },
    loadKey: loadMailboxPushKey,
    notifyDelivered: notifyMailboxDelivered,
    prepare: async (secretKey) => {
      // Keychain items can survive iOS reinstallation; replace the key before accepting wakes.
      await saveMailboxPushKey(secretKey);

      if (!(await isTaskRegisteredAsync(MAILBOX_TASK))) {
        await registerTaskAsync(MAILBOX_TASK);
      }
    },
  },
  performCatchup,
  performHandoff,
  performPoll,
  performSend,
  randomUUID,
  subscribeAppResume: (onResume) => {
    let previous = AppState.currentState;

    const subscription = AppState.addEventListener("change", (next) => {
      if (
        next === "active" &&
        (previous === "background" || previous === "inactive")
      ) {
        onResume();
      }

      previous = next;
    });

    return () => subscription.remove();
  },
});
