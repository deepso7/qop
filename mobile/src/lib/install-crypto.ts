import { getRandomValues } from "expo-crypto";
import { Platform } from "react-native";

// Noble uses this for secret scalar blinding as well as HPKE key generation.
if (Platform.OS !== "web") {
  if (!globalThis.crypto) {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { getRandomValues },
    });
  } else if (!globalThis.crypto.getRandomValues) {
    Object.defineProperty(globalThis.crypto, "getRandomValues", {
      configurable: true,
      value: getRandomValues,
    });
  }
}
