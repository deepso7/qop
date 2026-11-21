import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { useFocusEffect } from "expo-router";
import * as React from "react";
import type { View } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { cn } from "@/lib/utils";

const duration = 1000;

const skeletonVariants = cva("bg-secondary dark:bg-muted", {
  defaultVariants: { variant: "default" },
  variants: {
    variant: {
      // Stands in for an avatar or other round media.
      circle: "rounded-full",
      default: "rounded-md",
    },
  },
});

const Skeleton = ({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof View> &
  React.RefAttributes<View> &
  VariantProps<typeof skeletonVariants>) => {
  const sv = useSharedValue(1);
  const reduceMotion = useReducedMotion();

  useFocusEffect(
    React.useCallback(() => {
      sv.set(1);

      if (reduceMotion) {
        return;
      }

      sv.set(withRepeat(withTiming(0.5, { duration }), -1, true));

      return () => cancelAnimation(sv);
    }, [reduceMotion, sv])
  );

  const animatedStyle = useAnimatedStyle(
    () => ({
      opacity: sv.get(),
    }),
    [sv]
  );

  return (
    <Animated.View
      style={animatedStyle}
      className={cn(skeletonVariants({ variant }), className)}
      {...props}
    />
  );
};

export { Skeleton };
