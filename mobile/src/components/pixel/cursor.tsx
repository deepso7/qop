import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

import { cn } from "@/lib/utils";

const BLINK = { duration: 0, easing: Easing.linear };

// A terminal block cursor that blinks while work is in progress. Pass a bg-*
// class for its colour; reduced motion keeps it solid.
export const Cursor = ({ className }: { className?: string }) => {
  const reduceMotion = useReducedMotion();
  const opacity = useSharedValue(1);

  useEffect(() => {
    if (reduceMotion) {
      return;
    }

    // Hard on/off steps, ~530ms each like a real terminal caret.
    opacity.set(
      withRepeat(
        withSequence(
          withTiming(1, BLINK),
          withTiming(1, { duration: 530 }),
          withTiming(0, BLINK),
          withTiming(0, { duration: 530 })
        ),
        -1
      )
    );

    return () => cancelAnimation(opacity);
  }, [opacity, reduceMotion]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.get() }));

  return (
    <Animated.View
      accessibilityElementsHidden
      className={cn("h-4 w-2", className)}
      importantForAccessibility="no"
      style={animatedStyle}
    />
  );
};

// A square pixel, used as a list bullet and status light (the web footer's dot).
export const PixelDot = ({ className }: { className?: string }) => (
  <View className={cn("bg-foreground size-2", className)} />
);
