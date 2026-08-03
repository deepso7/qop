import { Image } from "expo-image";
import { version } from "expo/package.json";
import { useColorScheme, StyleSheet } from "react-native";

import expoBadgeWhite from "@/assets/images/expo-badge-white.png";
import expoBadge from "@/assets/images/expo-badge.png";

import { ThemedText } from "./themed-text";
import { ThemedView } from "./themed-view";

const styles = StyleSheet.create({
  badgeImage: {
    aspectRatio: 123 / 24,
    width: 123,
  },
});

export const WebBadge = () => {
  const scheme = useColorScheme();

  return (
    <ThemedView className="items-center gap-2 p-8">
      <ThemedText
        className="text-center"
        type="code"
        themeColor="textSecondary"
      >
        v{version}
      </ThemedText>
      <Image
        source={scheme === "dark" ? expoBadgeWhite : expoBadge}
        style={styles.badgeImage}
      />
    </ThemedView>
  );
};
