import type { ComponentProps, ReactNode } from "react";
import { ScrollView, View } from "react-native";

import { cn } from "@/lib/utils";

const contentVariants = {
  catalog: "w-full max-w-3xl self-center gap-7 px-6 pt-12",
  content: "w-full max-w-2xl self-center gap-8 px-6 pt-12",
  hero: "w-full max-w-2xl self-center gap-6 px-6 pt-16",
} as const;

export type ScreenProps = Omit<
  ComponentProps<typeof ScrollView>,
  "children"
> & {
  children: ReactNode;
  contentClassName?: string;
  variant?: keyof typeof contentVariants;
};

export const Screen = ({
  className,
  children,
  contentClassName,
  contentContainerClassName,
  contentInsetAdjustmentBehavior = "automatic",
  variant = "content",
  ...props
}: ScreenProps) => (
  <ScrollView
    className={cn("flex-1 bg-background", className)}
    contentContainerClassName={cn("pb-24 web:pb-8", contentContainerClassName)}
    contentInsetAdjustmentBehavior={contentInsetAdjustmentBehavior}
    {...props}
  >
    <View className={cn(contentVariants[variant], contentClassName)}>
      {children}
    </View>
  </ScrollView>
);
