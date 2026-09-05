import { Minip2p, bindAppState } from "@minip2p/react-native";
import { randomUUID } from "expo-crypto";

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
});
