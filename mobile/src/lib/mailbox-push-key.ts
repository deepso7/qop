import { decodeBase64, encodeBase64 } from "@qop/protocol";
import * as SecureStore from "expo-secure-store";

const KEY = "qop.mailbox.device-key.v1";

// Only the device key needs to be available while locked, not the recovery key.
export const saveMailboxPushKey = (secretKey: Uint8Array) =>
  SecureStore.setItemAsync(KEY, encodeBase64(secretKey), {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });

export const loadMailboxPushKey = async () => {
  const stored = await SecureStore.getItemAsync(KEY);

  if (stored) {
    const key = decodeBase64(stored);

    if (key.length === 32) {
      return key;
    }
  }
};

export const deleteMailboxPushKey = () => SecureStore.deleteItemAsync(KEY);
