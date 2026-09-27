import {
  HostPaletteContext,
  useMaterialColors,
} from "@expo/ui/jetpack-compose";
import { useMemo } from "react";
import type { ReactNode } from "react";
import { useColorScheme } from "react-native";

/**
 * Android FieldGroup sections paint rows with the Material `surfaceContainer`
 * color, which the orange seed tints. Use iOS's grouped-cell colors instead so
 * settings cards look the same on both platforms. Render inside `<Host>`.
 */
export const SettingsPalette = ({ children }: { children: ReactNode }) => {
  const palette = useMaterialColors();
  const dark = useColorScheme() === "dark";
  const value = useMemo(
    () => ({
      ...palette,
      surfaceContainer: dark ? ("#1C1C1EFF" as const) : ("#FFFFFFFF" as const),
    }),
    [dark, palette]
  );
  return (
    <HostPaletteContext.Provider value={value}>
      {children}
    </HostPaletteContext.Provider>
  );
};
