import * as SplashScreen from "expo-splash-screen";
import { useState } from "react";
import { Dimensions, View } from "react-native";
import Animated, { Easing, Keyframe } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import expoLogo from "@/assets/images/expo-logo.png";
import logoGlow from "@/assets/images/logo-glow.png";
import { Image } from "@/components/ui/image";

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

const glowKeyframe = new Keyframe({
  0: {
    transform: [{ rotateZ: "0deg" }],
  },
  100: {
    transform: [{ rotateZ: "7200deg" }],
  },
});

export const AnimatedIcon = () => (
  <View className="z-100 size-32 items-center justify-center">
    <Animated.View
      entering={glowKeyframe.duration(60 * 1000 * 4)}
      className="absolute size-50.25"
    >
      <Image className="absolute size-50.25" source={logoGlow} />
    </Animated.View>

    <Animated.View
      entering={keyframe.duration(DURATION)}
      className="rounded-icon absolute size-32 bg-linear-to-b from-(--qop-orange-light) to-(--qop-orange-dark)"
    />
    <Animated.View
      className="items-center justify-center"
      entering={logoKeyframe.duration(DURATION)}
    >
      <Image className="h-17.75 w-19" source={expoLogo} />
    </Animated.View>
  </View>
);
