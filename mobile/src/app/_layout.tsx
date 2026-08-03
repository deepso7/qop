import { PortalHost } from "@rn-primitives/portal";
import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useColorScheme } from "react-native";
import {
  SafeAreaListener,
  SafeAreaProvider,
} from "react-native-safe-area-context";
import { Uniwind } from "uniwind";

import { AnimatedSplashOverlay } from "@/components/animated-icon";
import AppTabs from "@/components/app-tabs";
import { useTheme } from "@/constants/theme";

import "../../global.css";

SplashScreen.preventAutoHideAsync();

const TabLayout = () => {
  const colorScheme = useColorScheme();
  const colors = useTheme();
  const baseTheme = colorScheme === "dark" ? DarkTheme : DefaultTheme;
  const navigationTheme = {
    ...baseTheme,
    colors: {
      ...baseTheme.colors,
      background: colors.background,
      border: colors.border,
      card: colors.background,
      notification: colors.primary,
      primary: colors.primary,
      text: colors.text,
    },
  };

  return (
    <SafeAreaProvider>
      <SafeAreaListener onChange={({ insets }) => Uniwind.updateInsets(insets)}>
        <ThemeProvider value={navigationTheme}>
          <AnimatedSplashOverlay />
          <AppTabs />
          <PortalHost />
        </ThemeProvider>
      </SafeAreaListener>
    </SafeAreaProvider>
  );
};

export default TabLayout;
