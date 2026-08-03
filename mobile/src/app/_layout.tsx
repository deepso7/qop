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
import { Colors } from "@/constants/theme";

import "../../global.css";

SplashScreen.preventAutoHideAsync();

const lightNavigationTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: Colors.light.background,
    border: Colors.light.backgroundSelected,
    card: Colors.light.background,
    notification: "#B96C45",
    primary: "#B96C45",
    text: Colors.light.text,
  },
};

const darkNavigationTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: Colors.dark.background,
    border: Colors.dark.backgroundSelected,
    card: Colors.dark.background,
    notification: "#B96C45",
    primary: "#B96C45",
    text: Colors.dark.text,
  },
};

const TabLayout = () => {
  const colorScheme = useColorScheme();
  return (
    <SafeAreaProvider>
      <SafeAreaListener onChange={({ insets }) => Uniwind.updateInsets(insets)}>
        <ThemeProvider
          value={
            colorScheme === "dark" ? darkNavigationTheme : lightNavigationTheme
          }
        >
          <AnimatedSplashOverlay />
          <AppTabs />
          <PortalHost />
        </ThemeProvider>
      </SafeAreaListener>
    </SafeAreaProvider>
  );
};

export default TabLayout;
