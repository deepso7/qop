import type { ComponentProps } from "react";
import { ScrollView } from "react-native";

import { cn } from "@/lib/utils";

export type ScreenProps = ComponentProps<typeof ScrollView>;

export const Screen = ({
  className,
  contentContainerClassName,
  contentInsetAdjustmentBehavior = "automatic",
  ...props
}: ScreenProps) => (
  <ScrollView
    className={cn("flex-1 bg-background", className)}
    contentContainerClassName={cn("pb-24 web:pb-8", contentContainerClassName)}
    contentInsetAdjustmentBehavior={contentInsetAdjustmentBehavior}
    {...props}
  />
);
