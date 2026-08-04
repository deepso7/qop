import { PortalHost } from "@rn-primitives/portal";
import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router";
import { Stack } from "expo-router/stack";
import * as SplashScreen from "expo-splash-screen";
import { View, useColorScheme } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";

import { AnimatedSplashOverlay } from "@/components/animated-icon";
import { BlurTargetProvider } from "@/components/ui/blur-target";
import { useTheme } from "@/constants/theme";

import "../../global.css";

SplashScreen.preventAutoHideAsync();

const RootLayout = () => {
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
    <KeyboardProvider>
      <ThemeProvider value={navigationTheme}>
        <View className="flex-1">
          <BlurTargetProvider>
            <AnimatedSplashOverlay />
            <Stack
              screenOptions={{
                contentStyle: { backgroundColor: colors.background },
                headerBackButtonDisplayMode: "minimal",
                headerShadowVisible: false,
                headerStyle: { backgroundColor: colors.background },
                headerTintColor: colors.text,
              }}
            >
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="chat/[id]" options={{ title: "Chat" }} />
            </Stack>
          </BlurTargetProvider>
          <PortalHost />
        </View>
      </ThemeProvider>
    </KeyboardProvider>
  );
};

export default RootLayout;
