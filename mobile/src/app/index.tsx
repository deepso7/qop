import * as Device from "expo-device";
import { Platform } from "react-native";

import { AnimatedIcon } from "@/components/animated-icon";
import { HintRow } from "@/components/hint-row";
import { Screen } from "@/components/screen";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { WebBadge } from "@/components/web-badge";

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
  <Screen contentContainerClassName="flex-row justify-center px-6 pt-16">
    <ThemedView className="w-full max-w-2xl items-center gap-6">
      <ThemedView className="items-center gap-6 px-6">
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
    </ThemedView>
  </Screen>
);

export default HomeScreen;
