import * as SplashScreen from "expo-splash-screen";
import { useState } from "react";
import { Dimensions, View } from "react-native";
import Animated, { Easing, Keyframe } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import expoLogo from "@/assets/images/expo-logo.png";
import { QopMark } from "@/components/brand-mark";
import { Image } from "@/components/ui/image";
import { useTheme } from "@/constants/theme";

const INITIAL_SCALE_FACTOR = Dimensions.get("screen").height / 90;
const DURATION = 600;

export const AnimatedSplashOverlay = () => {
  const [animate, setAnimate] = useState(false);
  const [visible, setVisible] = useState(true);

  if (!visible) {
    return null;
  }

  const splashKeyframe = new Keyframe({
    0: {
      opacity: 1,
      transform: [{ scale: 1 }],
    },
    100: {
      easing: Easing.elastic(0.7),
      opacity: 0,
      transform: [{ scale: 1 }],
    },
    20: {
      opacity: 1,
    },
    70: {
      easing: Easing.elastic(0.7),
      opacity: 0,
    },
  });

  const image = <Image className="h-17.75 w-19" source={expoLogo} />;

  return animate ? (
    <Animated.View
      entering={splashKeyframe.duration(DURATION).withCallback((finished) => {
        "worklet";

        if (finished) {
          scheduleOnRN(setVisible, false);
        }
      })}
      className="bg-primary absolute inset-0 z-1000 items-center justify-center"
    >
      {image}
    </Animated.View>
  ) : (
    <View
      onLayout={() => {
        void (async () => {
          try {
            await SplashScreen.hideAsync();
          } catch {
            // Splash may already be hidden; still start the transition.
          }

          setAnimate(true);
        })();
      }}
      className="bg-primary absolute inset-0 z-1000 items-center justify-center"
    >
      {image}
    </View>
  );
};

const keyframe = new Keyframe({
  0: {
    transform: [{ scale: INITIAL_SCALE_FACTOR }],
  },
  100: {
    easing: Easing.elastic(0.7),
    transform: [{ scale: 1 }],
  },
});

const logoKeyframe = new Keyframe({
  0: {
    opacity: 0,
    transform: [{ scale: 1.3 }],
  },
  100: {
    easing: Easing.elastic(0.7),
    opacity: 1,
    transform: [{ scale: 1 }],
  },
  40: {
    easing: Easing.elastic(0.7),
    opacity: 0,
    transform: [{ scale: 1.3 }],
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
