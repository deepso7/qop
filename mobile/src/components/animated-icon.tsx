import { Image } from "expo-image";
import * as SplashScreen from "expo-splash-screen";
import { useState } from "react";
import { Dimensions, StyleSheet, View } from "react-native";
import Animated, { Easing, Keyframe } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import expoLogo from "@/assets/images/expo-logo.png";
import logoGlow from "@/assets/images/logo-glow.png";

const INITIAL_SCALE_FACTOR = Dimensions.get("screen").height / 90;
const DURATION = 600;

const styles = StyleSheet.create({
  background: {
    borderRadius: 40,
    experimental_backgroundImage: `linear-gradient(180deg, #3C9FFE, #0274DF)`,
    height: 128,
    position: "absolute",
    width: 128,
  },
  glow: {
    height: 201,
    position: "absolute",
    width: 201,
  },
  iconContainer: {
    alignItems: "center",
    height: 128,
    justifyContent: "center",
    width: 128,
    zIndex: 100,
  },
  image: {
    height: 71,
    width: 76,
  },
  imageContainer: {
    alignItems: "center",
    justifyContent: "center",
  },
  splashOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    backgroundColor: "#208AEF",
    justifyContent: "center",
    zIndex: 1000,
  },
});

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

  const image = <Image style={styles.image} source={expoLogo} />;

  return animate ? (
    <Animated.View
      entering={splashKeyframe.duration(DURATION).withCallback((finished) => {
        "worklet";
        if (finished) {
          scheduleOnRN(setVisible, false);
        }
      })}
      style={styles.splashOverlay}
    >
      {image}
    </Animated.View>
  ) : (
    <View
      onLayout={async () => {
        try {
          await SplashScreen.hideAsync();
        } finally {
          setAnimate(true);
        }
      }}
      style={styles.splashOverlay}
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
  <View style={styles.iconContainer}>
    <Animated.View
      entering={glowKeyframe.duration(60 * 1000 * 4)}
      style={styles.glow}
    >
      <Image style={styles.glow} source={logoGlow} />
    </Animated.View>

    <Animated.View
      entering={keyframe.duration(DURATION)}
      style={styles.background}
    />
    <Animated.View
      style={styles.imageContainer}
      entering={logoKeyframe.duration(DURATION)}
    >
      <Image style={styles.image} source={expoLogo} />
    </Animated.View>
  </View>
);
