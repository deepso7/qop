import { Image } from "expo-image";
import { version } from "expo/package.json";
import { useColorScheme, StyleSheet } from "react-native";

import expoBadgeWhite from "@/assets/images/expo-badge-white.png";
import expoBadge from "@/assets/images/expo-badge.png";
import { Spacing } from "@/constants/theme";

import { ThemedText } from "./themed-text";
import { ThemedView } from "./themed-view";

const styles = StyleSheet.create({
  badgeImage: {
    aspectRatio: 123 / 24,
    width: 123,
  },
  container: {
    alignItems: "center",
    gap: Spacing.two,
    padding: Spacing.five,
  },
  versionText: {
    textAlign: "center",
  },
});

export const WebBadge = () => {
  const scheme = useColorScheme();

  return (
    <ThemedView style={styles.container}>
      <ThemedText
        type="code"
        themeColor="textSecondary"
        style={styles.versionText}
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
