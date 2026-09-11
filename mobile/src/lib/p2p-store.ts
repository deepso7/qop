import { Minip2p, bindAppState } from "@minip2p/react-native";
import { randomUUID } from "expo-crypto";
import { AppState } from "react-native";
import type { AppStateStatus } from "react-native";

import { useIdentityStore } from "./identity-store";
import { loadDeviceSecretKey } from "./identity-vault";
import { performSend } from "./p2p-send";
import { createP2pStore } from "./p2p-store-core";
import { lookupDeviceKey, lookupHandle } from "./registry";

export const useP2pStore = createP2pStore({
  createEndpoint: (options) => {
    const endpoint = Minip2p.create(options);
    return { bindAppState: () => bindAppState(endpoint), endpoint };
  },
  getIdentityHandle: () => useIdentityStore.getState().identity?.handle,
  loadDeviceSecretKey,
  lookupDeviceKey,
  lookupHandle,
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
