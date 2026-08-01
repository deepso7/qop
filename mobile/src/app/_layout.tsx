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

import "../../global.css";

SplashScreen.preventAutoHideAsync();

const TabLayout = () => {
  const colorScheme = useColorScheme();
  return (
    <SafeAreaProvider>
      <SafeAreaListener onChange={({ insets }) => Uniwind.updateInsets(insets)}>
        <ThemeProvider
          value={colorScheme === "dark" ? DarkTheme : DefaultTheme}
        >
          <AnimatedSplashOverlay />
          <AppTabs />
        </ThemeProvider>
      </SafeAreaListener>
    </SafeAreaProvider>
  );
};

export default TabLayout;
