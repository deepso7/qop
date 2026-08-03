import type { ReactNode } from "react";
import { View } from "react-native";

import { Surface } from "@/components/ui/surface";
import { Text } from "@/components/ui/text";

interface HintRowProps {
  title?: string;
  hint?: ReactNode;
}

export const HintRow = ({
  title = "Try editing",
  hint = "app/index.tsx",
}: HintRowProps) => (
  <View className="flex-row items-center justify-between gap-4">
    <Text variant="caption">{title}</Text>
    <Surface className="shrink rounded-md px-2.5 py-1" tone="selected">
      {typeof hint === "string" ? (
        <Text className="text-foreground-secondary" variant="mono">
          {hint}
        </Text>
      ) : (
        hint
      )}
    </Surface>
  </View>
);
