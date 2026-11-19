import { View } from "react-native";
import Animated, { Keyframe, Easing } from "react-native-reanimated";

import { QopMark } from "@/components/brand-mark";
import { useTheme } from "@/constants/theme";

const DURATION = 300;

export const AnimatedSplashOverlay = () => null;

const keyframe = new Keyframe({
  0: {
    transform: [{ scale: 0 }],
  },
  100: {
    easing: Easing.elastic(1.2),
    transform: [{ scale: 1 }],
  },
  60: {
    easing: Easing.elastic(1.2),
    transform: [{ scale: 1.2 }],
  },
});

const logoKeyframe = new Keyframe({
  0: {
    opacity: 0,
  },
  100: {
    easing: Easing.elastic(1.2),
    opacity: 1,
    transform: [{ scale: 1 }],
  },
  60: {
    easing: Easing.elastic(1.2),
    opacity: 0,
    transform: [{ scale: 1.2 }],
  },
});

export const AnimatedIcon = () => {
  const colors = useTheme();

  return (
    <View className="size-32 items-center justify-center">
      <Animated.View
        entering={keyframe.duration(DURATION)}
        className="bg-foam border-continuous rounded-icon absolute size-32"
      />
      <Animated.View
        entering={logoKeyframe.duration(DURATION)}
        className="items-center justify-center"
      >
        <QopMark color={colors.brand} size={128} />
      </Animated.View>
    </View>
  );
};
