import * as Device from "expo-device";
import { View } from "react-native";

import { AnimatedIcon } from "@/components/animated-icon";
import { Screen } from "@/components/screen";
import { HintRow } from "@/components/ui/hint-row";
import { Surface } from "@/components/ui/surface";
import { Text } from "@/components/ui/text";
import { WebBadge } from "@/components/web-badge";

const getDevMenuHint = () => {
  if (process.env.EXPO_OS === "web") {
    return <Text variant="caption">use browser devtools</Text>;
  }
  if (Device.isDevice) {
    return (
      <Text variant="caption">
        shake device or press <Text variant="mono">m</Text> in terminal
      </Text>
    );
  }
  const shortcut =
    process.env.EXPO_OS === "android" ? "cmd+m (or ctrl+m)" : "cmd+d";
  return (
    <Text variant="caption">
      press <Text variant="mono">{shortcut}</Text>
    </Text>
  );
};

const HomeScreen = () => (
  <Screen contentClassName="items-center" variant="hero">
    <View className="items-center gap-6 px-6">
      <AnimatedIcon />
      <Text className="text-center" variant="display">
        Welcome to&nbsp;Expo
      </Text>
    </View>

    <Text className="uppercase" variant="mono">
      get started
    </Text>

    <Surface className="self-stretch gap-4 rounded-xl px-4 py-6" tone="element">
      <HintRow
        title="Try editing"
        hint={<Text variant="mono">src/app/index.tsx</Text>}
      />
      <HintRow title="Dev tools" hint={getDevMenuHint()} />
      <HintRow
        title="Fresh start"
        hint={<Text variant="mono">npm run reset-project</Text>}
      />
    </Surface>

    {process.env.EXPO_OS === "web" && <WebBadge />}
  </Screen>
);

export default HomeScreen;
