import * as Device from "expo-device";
import { Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { withUniwind } from "uniwind";

import { AnimatedIcon } from "@/components/animated-icon";
import { HintRow } from "@/components/hint-row";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { WebBadge } from "@/components/web-badge";

const StyledSafeAreaView = withUniwind(SafeAreaView);

const getDevMenuHint = () => {
  if (Platform.OS === "web") {
    return <ThemedText type="small">use browser devtools</ThemedText>;
  }
  if (Device.isDevice) {
    return (
      <ThemedText type="small">
        shake device or press <ThemedText type="code">m</ThemedText> in terminal
      </ThemedText>
    );
  }
  const shortcut = Platform.OS === "android" ? "cmd+m (or ctrl+m)" : "cmd+d";
  return (
    <ThemedText type="small">
      press <ThemedText type="code">{shortcut}</ThemedText>
    </ThemedText>
  );
};

const HomeScreen = () => (
  <ThemedView className="flex-1 flex-row justify-center">
    <StyledSafeAreaView className="max-w-[800px] flex-1 items-center gap-4 px-6 pb-4 ios:pb-[66px] android:pb-24">
      <ThemedView className="flex-1 items-center justify-center gap-6 px-6">
        <AnimatedIcon />
        <ThemedText className="text-center" type="title">
          Welcome to&nbsp;Expo
        </ThemedText>
      </ThemedView>

      <ThemedText className="uppercase" type="code">
        get started
      </ThemedText>

      <ThemedView
        className="self-stretch gap-4 rounded-3xl px-4 py-6"
        type="backgroundElement"
      >
        <HintRow
          title="Try editing"
          hint={<ThemedText type="code">src/app/index.tsx</ThemedText>}
        />
        <HintRow title="Dev tools" hint={getDevMenuHint()} />
        <HintRow
          title="Fresh start"
          hint={<ThemedText type="code">npm run reset-project</ThemedText>}
        />
      </ThemedView>

      {Platform.OS === "web" && <WebBadge />}
    </StyledSafeAreaView>
  </ThemedView>
);

export default HomeScreen;
