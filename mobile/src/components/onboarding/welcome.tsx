import { View } from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";

import { Lede } from "@/components/onboarding/chrome";
import { Peers } from "@/components/pixel/peers";
import { PixelButton } from "@/components/pixel/pixel-button";
import { Text } from "@/components/ui/text";

const enter = FadeIn.duration(240).reduceMotion(ReduceMotion.System);

export interface WelcomeProps {
  onCreate: () => void;
  // Starts restoring an existing account with its recovery key.
  onRestore: () => void;
}

// The first screen: the two-peer art above, the pitch and actions below.
export const Welcome = ({ onCreate, onRestore }: WelcomeProps) => (
  <Animated.View className="flex-1" entering={enter}>
    {/* The art takes whatever height the copy leaves, under the status bar. */}
    <View className="mt-safe flex-1">
      <Peers />
    </View>
    <View className="pb-safe-offset-10 gap-8 px-6 pt-4">
      <View className="gap-4">
        <Text tone="link" variant="tag">
          peer → peer
        </Text>
        <Text variant="hero">Nothing in{"\n"}the middle.</Text>
        <Lede>
          qop sends each message straight from your phone to theirs. Your keys
          are made here and never leave it.
        </Lede>
      </View>
      <View className="gap-2">
        <PixelButton
          accessibilityHint="Starts creating a new qop account"
          label="Create your qop"
          onPress={onCreate}
          trailing="→"
        />
        <PixelButton
          accessibilityHint="Restores your account with its recovery key"
          label="I already have a qop"
          onPress={onRestore}
          variant="quiet"
        />
      </View>
    </View>
  </Animated.View>
);
