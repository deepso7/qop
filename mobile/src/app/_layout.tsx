import { PortalHost } from "@rn-primitives/portal";
import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { View, useColorScheme } from "react-native";

import { AnimatedSplashOverlay } from "@/components/animated-icon";
import AppTabs from "@/components/app-tabs";
import { BlurTargetProvider } from "@/components/ui/blur-target";
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
    <ThemeProvider value={navigationTheme}>
      <View className="flex-1">
        <BlurTargetProvider>
          <AnimatedSplashOverlay />
          <AppTabs />
        </BlurTargetProvider>
        <PortalHost />
      </View>
    </ThemeProvider>
  );
};

export default TabLayout;
