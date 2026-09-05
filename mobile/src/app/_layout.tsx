import { PortalHost } from "@rn-primitives/portal";
import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router";
import { Stack } from "expo-router/stack";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import * as React from "react";
import { View, useColorScheme } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";

import { BlurTargetProvider } from "@/components/ui/blur-target";
import { useTheme } from "@/constants/theme";
import { useIdentityStore } from "@/lib/identity-store";
import { useP2pStore } from "@/lib/p2p-store";

import "../../global.css";

void SplashScreen.preventAutoHideAsync();
SplashScreen.setOptions({ duration: 250, fade: true });

const MAX_P2P_RESTART_ATTEMPTS = 5;
const P2P_RESTART_DELAY_MS = 2000;
const MAX_P2P_RESTART_DELAY_MS = 30_000;

const AppStack = () => {
  const colors = useTheme();
  const hydrate = useIdentityStore((state) => state.hydrate);
  const status = useIdentityStore((state) => state.status);
  const startP2p = useP2pStore((state) => state.start);
  const stopP2p = useP2pStore((state) => state.stop);
  const p2pStatus = useP2pStore((state) => state.status);
  const isReady = status === "ready";
  const p2pRestartAttempts = React.useRef(0);

  React.useEffect(() => {
    void hydrate();
  }, [hydrate]);

  React.useEffect(() => {
    if (status !== "loading") {
      void SplashScreen.hideAsync();
    }
  }, [status]);

  // Start once identity is ready; stop when it leaves ready.
  React.useEffect(() => {
    if (status === "ready") {
      p2pRestartAttempts.current = 0;
      void startP2p();
      return () => {
        void stopP2p();
      };
    }
    void stopP2p();
  }, [startP2p, status, stopP2p]);

  // Retry hard failures a finite number of times. Do not reset this budget on
  // "running": a synchronously-created endpoint can fail again immediately.
  React.useEffect(() => {
    if (
      status !== "ready" ||
      p2pStatus !== "failed" ||
      p2pRestartAttempts.current >= MAX_P2P_RESTART_ATTEMPTS
    ) {
      return;
    }
    const attempt = p2pRestartAttempts.current;
    p2pRestartAttempts.current += 1;
    let cancelled = false;
    const timer = setTimeout(
      () => {
        if (!cancelled) {
          void startP2p();
        }
      },
      Math.min(P2P_RESTART_DELAY_MS * 2 ** attempt, MAX_P2P_RESTART_DELAY_MS)
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [p2pStatus, startP2p, status]);

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
            <Stack.Screen name="new-chat" options={{ title: "New chat" }} />
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
      <StatusBar style={colorScheme === "dark" ? "light" : "dark"} />
      <ThemeProvider value={navigationTheme}>
        <AppStack />
      </ThemeProvider>
    </KeyboardProvider>
  );
};

export default RootLayout;
