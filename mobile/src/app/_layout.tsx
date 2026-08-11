import { PortalHost } from "@rn-primitives/portal";
import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router";
import { Stack } from "expo-router/stack";
import * as SplashScreen from "expo-splash-screen";
import * as React from "react";
import { View, useColorScheme } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";

import { BlurTargetProvider } from "@/components/ui/blur-target";
import { useTheme } from "@/constants/theme";
import { useIdentityStore } from "@/lib/identity-store";

import "../../global.css";

void SplashScreen.preventAutoHideAsync();
SplashScreen.setOptions({ duration: 250, fade: true });

const AppStack = () => {
  const colors = useTheme();
  const hydrate = useIdentityStore((state) => state.hydrate);
  const status = useIdentityStore((state) => state.status);
  const isReady = status === "ready";

  React.useEffect(() => {
    void hydrate();
  }, [hydrate]);

  React.useEffect(() => {
    if (status !== "loading") {
      void SplashScreen.hideAsync();
    }
  }, [status]);

  if (status === "loading") {
    return null;
  }

  return (
    <View className="flex-1">
      <BlurTargetProvider>
        <Stack
          screenOptions={{
            contentStyle: { backgroundColor: colors.background },
            headerBackButtonDisplayMode: "minimal",
            headerShadowVisible: false,
            headerStyle: { backgroundColor: colors.background },
            headerTintColor: colors.text,
          }}
        >
          <Stack.Protected guard={!isReady}>
            <Stack.Screen name="onboarding" options={{ headerShown: false }} />
          </Stack.Protected>
          <Stack.Protected guard={isReady}>
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="chat/[id]" options={{ title: "Chat" }} />
          </Stack.Protected>
        </Stack>
      </BlurTargetProvider>
      <PortalHost />
    </View>
  );
};

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
        <AppStack />
      </ThemeProvider>
    </KeyboardProvider>
  );
};

export default RootLayout;
