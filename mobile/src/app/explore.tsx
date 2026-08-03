import { SymbolView } from "expo-symbols";
import type { PropsWithChildren } from "react";
import { useState } from "react";
import { Pressable } from "react-native";
import { withUniwind } from "uniwind";

import reactLogo from "@/assets/images/react-logo.png";
import tutorialWeb from "@/assets/images/tutorial-web.png";
import { ExternalLink } from "@/components/external-link";
import { Screen } from "@/components/screen";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Image } from "@/components/ui/image";
import { WebBadge } from "@/components/web-badge";

const StyledSymbolView = withUniwind(SymbolView);

const ExploreCollapsible = ({
  children,
  title,
}: PropsWithChildren<{ title: string }>) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Collapsible onOpenChange={setIsOpen} open={isOpen}>
      <CollapsibleTrigger asChild>
        <Pressable className="min-h-11 flex-row items-center gap-2 active:opacity-70">
          <ThemedView
            className="size-8 items-center justify-center rounded-xl"
            type="backgroundElement"
          >
            <StyledSymbolView
              className={isOpen ? "-rotate-90" : "rotate-90"}
              name={{
                android: "chevron_right",
                ios: "chevron.right",
                web: "chevron_right",
              }}
              size={14}
              tintColorClassName="accent-foreground"
              weight="bold"
            />
          </ThemedView>
          <ThemedText type="small">{title}</ThemedText>
        </Pressable>
      </CollapsibleTrigger>
      <CollapsibleContent className="ml-8 mt-3 gap-3 rounded-xl bg-background-element p-4">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
};

const TabTwoScreen = () => (
  <Screen contentContainerClassName="flex-row justify-center px-6 pt-12 web:pt-16">
    <ThemedView className="max-w-2xl flex-grow">
      <ThemedView className="items-center gap-4 py-12">
        <ThemedText type="subtitle">Explore</ThemedText>
        <ThemedText className="text-center" themeColor="textSecondary">
          This starter app includes example{"\n"}code to help you get started.
        </ThemedText>

        <ExternalLink href="https://docs.expo.dev" asChild>
          <Pressable className="min-h-11 justify-center active:opacity-70">
            <ThemedView
              className="flex-row items-center justify-center gap-1 rounded-4xl px-6 py-2"
              type="backgroundElement"
            >
              <ThemedText type="link">Expo documentation</ThemedText>
              <StyledSymbolView
                tintColorClassName="accent-foreground"
                name={{
                  android: "link",
                  ios: "arrow.up.right.square",
                  web: "link",
                }}
                size={12}
              />
            </ThemedView>
          </Pressable>
        </ExternalLink>
      </ThemedView>

      <ThemedView className="gap-8 pt-4">
        <ExploreCollapsible title="File-based routing">
          <ThemedText type="small">
            This app has two screens:{" "}
            <ThemedText type="code">src/app/index.tsx</ThemedText> and{" "}
            <ThemedText type="code">src/app/explore.tsx</ThemedText>
          </ThemedText>
          <ThemedText type="small">
            The layout file in{" "}
            <ThemedText type="code">src/app/_layout.tsx</ThemedText> sets up the
            tab navigator.
          </ThemedText>
          <ExternalLink href="https://docs.expo.dev/router/introduction">
            <ThemedText type="linkPrimary">Learn more</ThemedText>
          </ExternalLink>
        </ExploreCollapsible>

        <ExploreCollapsible title="Android, iOS, and web support">
          <ThemedView className="items-center" type="backgroundElement">
            <ThemedText type="small">
              You can open this project on Android, iOS, and the web. To open
              the web version, press <ThemedText type="smallBold">w</ThemedText>{" "}
              in the terminal running this project.
            </ThemedText>
            <Image
              className="mt-2 aspect-[296/171] w-full rounded-2xl"
              source={tutorialWeb}
            />
          </ThemedView>
        </ExploreCollapsible>

        <ExploreCollapsible title="Images">
          <ThemedText type="small">
            For static images, you can use the{" "}
            <ThemedText type="code">@2x</ThemedText> and{" "}
            <ThemedText type="code">@3x</ThemedText> suffixes to provide files
            for different screen densities.
          </ThemedText>
          <Image className="size-24 self-center" source={reactLogo} />
          <ExternalLink href="https://reactnative.dev/docs/images">
            <ThemedText type="linkPrimary">Learn more</ThemedText>
          </ExternalLink>
        </ExploreCollapsible>

        <ExploreCollapsible title="Light and dark mode components">
          <ThemedText type="small">
            This template has light and dark mode support. The{" "}
            <ThemedText type="code">useColorScheme()</ThemedText> hook lets you
            inspect what the user&apos;s current color scheme is, and so you can
            adjust UI colors accordingly.
          </ThemedText>
          <ExternalLink href="https://docs.expo.dev/develop/user-interface/color-themes/">
            <ThemedText type="linkPrimary">Learn more</ThemedText>
          </ExternalLink>
        </ExploreCollapsible>

        <ExploreCollapsible title="Animations">
          <ThemedText type="small">
            This template includes an example of an animated component. The{" "}
            <ThemedText type="code">
              src/components/ui/collapsible.tsx
            </ThemedText>{" "}
            component is built on the shared React Native Reusables primitive.
          </ThemedText>
        </ExploreCollapsible>
      </ThemedView>
      {process.env.EXPO_OS === "web" && <WebBadge />}
    </ThemedView>
  </Screen>
);

export default TabTwoScreen;
