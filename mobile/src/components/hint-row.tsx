import type { ReactNode } from "react";
import { View, StyleSheet } from "react-native";

import { Spacing } from "@/constants/theme";

import { ThemedText } from "./themed-text";
import { ThemedView } from "./themed-view";

interface HintRowProps {
  title?: string;
  hint?: ReactNode;
}

const styles = StyleSheet.create({
  codeSnippet: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
  },
  stepRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
});

export const HintRow = ({
  title = "Try editing",
  hint = "app/index.tsx",
}: HintRowProps) => (
  <View style={styles.stepRow}>
    <ThemedText type="small">{title}</ThemedText>
    <ThemedView type="backgroundSelected" style={styles.codeSnippet}>
      <ThemedText themeColor="textSecondary">{hint}</ThemedText>
    </ThemedView>
  </View>
);
