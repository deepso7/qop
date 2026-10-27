import { View } from "react-native";
import Animated, { Keyframe, Easing } from "react-native-reanimated";

import expoLogo from "@/assets/images/expo-logo.png";
import logoGlow from "@/assets/images/logo-glow.png";
import { Image } from "@/components/ui/image";

import classes from "./animated-icon.module.css";

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

const glowKeyframe = new Keyframe({
  0: {
    opacity: 0,
    transform: [{ rotateZ: "-180deg" }, { scale: 0.8 }],
  },
  [DURATION / 1000]: {
    easing: Easing.elastic(0.7),
    opacity: 1,
    transform: [{ rotateZ: "0deg" }, { scale: 1 }],
  },
  100: {
    transform: [{ rotateZ: "7200deg" }],
  },
});

export const AnimatedIcon = () => (
  <View className="size-32 items-center justify-center">
    <Animated.View
      entering={glowKeyframe.duration(60 * 1000 * 4)}
      className="absolute size-50.25"
    >
      <Image className="absolute size-50.25" source={logoGlow} />
    </Animated.View>

    <Animated.View
      className="absolute size-32"
      entering={keyframe.duration(DURATION)}
    >
      <div className={classes.expoLogoBackground} />
    </Animated.View>

    <Animated.View
      className="items-center justify-center"
      entering={logoKeyframe.duration(DURATION)}
    >
      <Image className="absolute h-17.75 w-19" source={expoLogo} />
    </Animated.View>
  </View>
);
