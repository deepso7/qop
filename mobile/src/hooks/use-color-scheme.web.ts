import { useSyncExternalStore } from "react";
import { useColorScheme as useRNColorScheme } from "react-native";

const emptySubscribe = () => () => {
  // Hydration only changes once when React switches from the server snapshot.
};

/**
 * To support static rendering, this value needs to be re-calculated on the client side for web
 */
export const useColorScheme = () => {
  const hasHydrated = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
  const colorScheme = useRNColorScheme();

  if (hasHydrated) {
    return colorScheme;
  }

  return "light";
};
