import { SymbolView } from "expo-symbols";
import type { PropsWithChildren } from "react";
import { useState } from "react";
import { Pressable, View } from "react-native";
import Animated, {
  Keyframe,
  LinearTransition,
  ReduceMotion,
  useAnimatedStyle,
  useDerivedValue,
  withTiming,
} from "react-native-reanimated";
import { withUniwind } from "uniwind";

import reactLogo from "@/assets/images/react-logo.png";
import tutorialWeb from "@/assets/images/tutorial-web.png";
import { ExternalLink } from "@/components/external-link";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Image } from "@/components/ui/image";
import { Surface } from "@/components/ui/surface";
import { Text } from "@/components/ui/text";
import { WebBadge } from "@/components/web-badge";

const StyledSymbolView = withUniwind(SymbolView);
const collapsibleEnter = new Keyframe({
  0: { opacity: 0, transform: [{ translateY: -4 }] },
  100: { opacity: 1, transform: [{ translateY: 0 }] },
})
  .duration(180)
  .reduceMotion(ReduceMotion.System);
const collapsibleExit = new Keyframe({
  0: { opacity: 1, transform: [{ translateY: 0 }] },
  100: { opacity: 0, transform: [{ translateY: -4 }] },
})
  .duration(140)
  .reduceMotion(ReduceMotion.System);
const collapsibleLayout = LinearTransition.duration(200).reduceMotion(
  ReduceMotion.System
);

const ExploreCollapsible = ({
  children,
  title,
}: PropsWithChildren<{ title: string }>) => {
  const [isOpen, setIsOpen] = useState(false);
  const chevronRotation = useDerivedValue(
    () =>
      withTiming(isOpen ? -90 : 90, {
        duration: isOpen ? 160 : 120,
        reduceMotion: ReduceMotion.System,
      }),
    [isOpen]
  );
  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotateZ: `${chevronRotation.get()}deg` }],
  }));

  return (
    <Animated.View layout={collapsibleLayout}>
      <Collapsible onOpenChange={setIsOpen} open={isOpen}>
        <CollapsibleTrigger asChild>
          <Pressable className="min-h-11 flex-row items-center gap-2 active:opacity-70">
            <Surface
              className="size-8 items-center justify-center rounded-md"
              tone="element"
            >
              <Animated.View style={chevronStyle}>
                <StyledSymbolView
                  name={{
                    android: "chevron_right",
                    ios: "chevron.right",
                    web: "chevron_right",
                  }}
                  size={14}
                  tintColorClassName="accent-foreground"
                  weight="bold"
                />
              </Animated.View>
            </Surface>
            <Text variant="caption">{title}</Text>
          </Pressable>
        </CollapsibleTrigger>
        <CollapsibleContent asChild>
          <Animated.View
            className="ml-8 mt-3 gap-3 rounded-xl bg-background-element p-4"
            entering={collapsibleEnter}
            exiting={collapsibleExit}
          >
            {children}
          </Animated.View>
        </CollapsibleContent>
      </Collapsible>
    </Animated.View>
  );
};

const TabTwoScreen = () => (
  <Screen variant="content">
    <View className="items-center gap-4">
      <Text variant="title">Explore</Text>
      <Text className="text-center text-foreground-secondary" variant="body">
        This starter app includes example{"\n"}code to help you get started.
      </Text>

      <ExternalLink href="https://docs.expo.dev" asChild>
        <Button variant="secondary">
          <Text>Expo documentation</Text>
          <StyledSymbolView
            tintColorClassName="accent-foreground"
            name={{
              android: "link",
              ios: "arrow.up.right.square",
              web: "link",
            }}
            size={12}
          />
        </Button>
      </ExternalLink>
    </View>

    <View className="gap-8">
      <ExploreCollapsible title="File-based routing">
        <Text variant="caption">
          This app has two screens:{" "}
          <Text variant="mono">src/app/index.tsx</Text> and{" "}
          <Text variant="mono">src/app/explore.tsx</Text>
        </Text>
        <Text variant="caption">
          The layout file in <Text variant="mono">src/app/_layout.tsx</Text>{" "}
          sets up the tab navigator.
        </Text>
        <ExternalLink href="https://docs.expo.dev/router/introduction">
          <Text variant="linkPrimary">Learn more</Text>
        </ExternalLink>
      </ExploreCollapsible>

      <ExploreCollapsible title="Android, iOS, and web support">
        <View className="items-center">
          <Text variant="caption">
            You can open this project on Android, iOS, and the web. To open the
            web version, press <Text variant="label">w</Text> in the terminal
            running this project.
          </Text>
          <Image
            className="mt-2 aspect-296/171 w-full rounded-xl"
            source={tutorialWeb}
          />
        </View>
      </ExploreCollapsible>

      <ExploreCollapsible title="Images">
        <Text variant="caption">
          For static images, you can use the <Text variant="mono">@2x</Text> and{" "}
          <Text variant="mono">@3x</Text> suffixes to provide files for
          different screen densities.
        </Text>
        <Image className="size-24 self-center" source={reactLogo} />
        <ExternalLink href="https://reactnative.dev/docs/images">
          <Text variant="linkPrimary">Learn more</Text>
        </ExternalLink>
      </ExploreCollapsible>

      <ExploreCollapsible title="Light and dark mode components">
        <Text variant="caption">
          This template has light and dark mode support. The{" "}
          <Text variant="mono">useColorScheme()</Text> hook lets you inspect
          what the user&apos;s current color scheme is, and so you can adjust UI
          colors accordingly.
        </Text>
        <ExternalLink href="https://docs.expo.dev/develop/user-interface/color-themes/">
          <Text variant="linkPrimary">Learn more</Text>
        </ExternalLink>
      </ExploreCollapsible>

      <ExploreCollapsible title="Animations">
        <Text variant="caption">
          This template includes an example of an animated component. The{" "}
          <Text variant="mono">src/components/ui/collapsible.tsx</Text>{" "}
          component is built on the shared React Native Reusables primitive.
        </Text>
      </ExploreCollapsible>
    </View>
    {process.env.EXPO_OS === "web" && <WebBadge />}
  </Screen>
);

export default TabTwoScreen;
