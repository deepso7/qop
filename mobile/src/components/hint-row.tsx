import type { ReactNode } from "react";
import { View } from "react-native";

import { ThemedText } from "./themed-text";
import { ThemedView } from "./themed-view";

interface HintRowProps {
  title?: string;
  hint?: ReactNode;
}

export const HintRow = ({
  title = "Try editing",
  hint = "app/index.tsx",
}: HintRowProps) => (
  <View className="flex-row items-center justify-between gap-4">
    <ThemedText type="small">{title}</ThemedText>
    <ThemedView className="rounded-lg px-2 py-0.5" type="backgroundSelected">
      <ThemedText themeColor="textSecondary">{hint}</ThemedText>
    </ThemedView>
  </View>
);
