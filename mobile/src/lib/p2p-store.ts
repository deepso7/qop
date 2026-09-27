import { Minip2p, bindAppState } from "@minip2p/react-native";
import { randomUUID } from "expo-crypto";
import { AppState } from "react-native";
import type { AppStateStatus } from "react-native";

import { useIdentityStore } from "./identity-store";
import { loadDeviceSecretKey } from "./identity-vault";
import { performSend } from "./p2p-send";
import { createP2pStore } from "./p2p-store-core";
import { performCatchup, performHandoff, performPoll } from "./p2p-sync";
import { lookupDeviceKey, lookupHandle, lookupQid } from "./registry";

export const useP2pStore = createP2pStore({
  createEndpoint: (options) => {
    const endpoint = Minip2p.create(options);
    return { bindAppState: () => bindAppState(endpoint), endpoint };
  },
  getIdentityHandle: () => useIdentityStore.getState().identity?.handle,
  getOwnDevice: () => {
    const { identity, registration } = useIdentityStore.getState();
    if (
      identity === null ||
      registration === null ||
      registration.qid === null
    ) {
      return;
    }
    return {
      deviceKey: identity.deviceKey,
      handle: identity.handle,
      peerId: identity.peerId,
      qid: registration.qid.toString(),
    };
  },
  loadDeviceSecretKey,
  lookupDeviceKey,
  lookupHandle,
  lookupQid,
  performCatchup,
  performHandoff,
  performPoll,
  performSend,
  randomUUID,
  subscribeAppResume: (onResume) => {
    let previous: AppStateStatus = AppState.currentState;
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
