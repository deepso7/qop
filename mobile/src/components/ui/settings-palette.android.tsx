import {
  HostPaletteContext,
  useMaterialColors,
} from "@expo/ui/jetpack-compose";
import { useMemo } from "react";
import type { ReactNode } from "react";
import { processColor } from "react-native";

import { useTheme } from "@/constants/theme";

/** Match grouped Material rows to the app’s element surface. */
export const SettingsPalette = ({ children }: { children: ReactNode }) => {
  const palette = useMaterialColors();
  const colors = useTheme();

  const value = useMemo(() => {
    // SAFETY: CSS tokens are static colors, not native dynamic color objects.
    const color = processColor(colors.backgroundElement) as number;

    const argb = ((color + 2 ** 32) % 2 ** 32).toString(16).padStart(8, "0");

    return {
      ...palette,
      surfaceContainer: `#${argb.slice(2)}${argb.slice(0, 2)}` as const,
    };
  }, [colors.backgroundElement, palette]);

  return (
    <HostPaletteContext.Provider value={value}>
      {children}
    </HostPaletteContext.Provider>
  );
};
