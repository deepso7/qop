import { Image } from "expo-image";
import { version } from "expo/package.json";
import { useColorScheme, StyleSheet, View } from "react-native";

import expoBadgeWhite from "@/assets/images/expo-badge-white.png";
import expoBadge from "@/assets/images/expo-badge.png";

import { Text } from "./ui/text";

const styles = StyleSheet.create({
  badgeImage: {
    aspectRatio: 123 / 24,
    width: 123,
  },
});

export const WebBadge = () => {
  const scheme = useColorScheme();

  return (
    <View className="items-center gap-2 pt-6 pb-2">
      <Text className="text-foreground-secondary text-center" variant="mono">
        v{version}
      </Text>
      <Image
        source={scheme === "dark" ? expoBadgeWhite : expoBadge}
        style={styles.badgeImage}
      />
    </View>
  );
};
