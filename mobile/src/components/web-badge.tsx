import { version } from "expo/package.json";
import { useColorScheme, View } from "react-native";

import expoBadgeWhite from "@/assets/images/expo-badge-white.png";
import expoBadge from "@/assets/images/expo-badge.png";

import { Image } from "./ui/image";
import { Text } from "./ui/text";

export const WebBadge = () => {
  const scheme = useColorScheme();

  return (
    <View className="items-center gap-2 pt-6 pb-2">
      <Text className="text-center" tone="secondary" variant="mono">
        v{version}
      </Text>
      <Image
        source={scheme === "dark" ? expoBadgeWhite : expoBadge}
        className="aspect-123/24 w-30.75"
      />
    </View>
  );
};
