import {
  BottomSheet as ExpoBottomSheet,
  Button as ExpoButton,
  Column as ExpoColumn,
  FieldGroup as ExpoFieldGroup,
  Host as ExpoHost,
  Row as ExpoRow,
  Slider as ExpoSlider,
  Spacer as ExpoSpacer,
  Switch as ExpoSwitch,
  Text as ExpoText,
} from "@expo/ui";
import { useState } from "react";
import { View } from "react-native";
import type { LayoutChangeEvent } from "react-native";
import { ScopedVariables, withUniwind } from "uniwind";

import expoLogo from "@/assets/images/expo-logo.png";
import { AnimatedIcon } from "@/components/animated-icon";
import { ChatCatalog } from "@/components/chat-catalog";
import { ExternalLink } from "@/components/external-link";
import { RnrCatalog } from "@/components/rnr-catalog";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { HintRow } from "@/components/ui/hint-row";
import { Image } from "@/components/ui/image";
import { SectionLabel } from "@/components/ui/section-label";
import { Surface } from "@/components/ui/surface";
import { Text } from "@/components/ui/text";
import { WebBadge } from "@/components/web-badge";
import { useTheme } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { cn } from "@/lib/utils";

const Host = withUniwind(ExpoHost);

// Expo UI Column/Row read a universal `style` object (mapped to SwiftUI/Compose
// modifiers). The explicit mapping hands them a plain object on native; the
// default one would pass an array, which they ignore.
const Column = withUniwind(ExpoColumn, {
  style: { fromClassName: "className" },
});

const Row = withUniwind(ExpoRow, { style: { fromClassName: "className" } });

const ComponentSection = ({
  children,
  title,
}: React.PropsWithChildren<{ title: string }>) => (
  <View className="gap-2">
    <SectionLabel>{title}</SectionLabel>
    <Surface variant="outline">{children}</Surface>
  </View>
);

/**
 * Hosts an Expo UI tree at a fixed height (`className`, e.g. `h-46`). Children
 * render once the width is measured and can size to it with `w-(--preview-width)`.
 */
const ExpoNativePreview = ({
  children,
  className,
  inset = false,
  seedColor,
}: React.PropsWithChildren<{
  className: string;
  inset?: boolean;
  seedColor?: string;
}>) => {
  const [contentWidth, setContentWidth] = useState(0);
  const colorScheme = useColorScheme() === "dark" ? "dark" : "light";

  const handleLayout = ({ nativeEvent }: LayoutChangeEvent) => {
    const nextWidth = nativeEvent.layout.width;
    setContentWidth((currentWidth) =>
      currentWidth === nextWidth ? currentWidth : nextWidth
    );
  };

  return (
    <View className="bg-background-element/50 overflow-hidden rounded-xl">
      <View className={inset ? "px-4 py-3" : undefined}>
        <View onLayout={handleLayout}>
          <Host
            className={cn("w-full", className)}
            colorScheme={colorScheme}
            ignoreSafeArea="all"
            seedColor={seedColor}
          >
            <ScopedVariables variables={{ "--preview-width": contentWidth }}>
              {contentWidth > 0 && children}
            </ScopedVariables>
          </Host>
        </View>
      </View>
    </View>
  );
};

const ExpoUICatalog = ({ onOpenSheet }: { onOpenSheet: () => void }) => {
  const [isSwitchedOn, setIsSwitchedOn] = useState(true);
  const [sliderValue, setSliderValue] = useState(60);
  const theme = useTheme();

  return (
    <View className="gap-5">
      <View className="gap-2">
        <Text variant="label">Platform controls</Text>
        <Text tone="secondary" variant="caption">
          Native rendering is intentional for settings and system preferences.
        </Text>
        <ExpoNativePreview className="h-46" inset seedColor={theme.primary}>
          <Column className="w-(--preview-width)" spacing={16}>
            <Row alignment="center" className="w-(--preview-width)">
              <ExpoText textStyle={{ color: theme.text }}>
                Native controls
              </ExpoText>
              <ExpoSpacer flexible />
              <ExpoSwitch
                onValueChange={setIsSwitchedOn}
                value={isSwitchedOn}
              />
            </Row>
            <Row alignment="center" className="w-(--preview-width)">
              <ExpoText textStyle={{ color: theme.textSecondary }}>
                Disabled switch
              </ExpoText>
              <ExpoSpacer flexible />
              <ExpoSwitch
                disabled
                onValueChange={setIsSwitchedOn}
                value={false}
              />
            </Row>
            <ExpoText textStyle={{ color: theme.text }}>
              {`Response length · ${Math.round(sliderValue)}`}
            </ExpoText>
            <ExpoSlider
              max={100}
              min={0}
              onValueChange={setSliderValue}
              step={1}
              value={sliderValue}
            />
          </Column>
        </ExpoNativePreview>
      </View>

      <View className="gap-2">
        <Text variant="label">Native settings group</Text>
        <ExpoNativePreview className="android:h-46 h-42">
          <ExpoFieldGroup>
            <ExpoFieldGroup.Section title="Preferences">
              <ExpoRow alignment="center">
                <ExpoText>Theme</ExpoText>
                <ExpoSpacer flexible />
                <ExpoText>System</ExpoText>
              </ExpoRow>
              <ExpoRow alignment="center">
                <ExpoText>Language</ExpoText>
                <ExpoSpacer flexible />
                <ExpoText>English</ExpoText>
              </ExpoRow>
            </ExpoFieldGroup.Section>
          </ExpoFieldGroup>
        </ExpoNativePreview>
      </View>

      <View className="gap-2">
        <Text variant="label">Native presentation</Text>
        <Button onPress={onOpenSheet} variant="outline">
          <Text>Open native bottom sheet</Text>
        </Button>
      </View>
    </View>
  );
};

const UIScreen = () => {
  const [isSheetPresented, setIsSheetPresented] = useState(false);

  return (
    <View className="flex-1">
      <Screen variant="catalog">
        <View className="gap-1 px-1 pb-1">
          <Text variant="title">UI</Text>
          <Text tone="secondary" variant="caption">
            Shared product primitives and their current states.
          </Text>
        </View>

        <ComponentSection title="QOP · branded primitives">
          <Text tone="secondary" variant="caption">
            Source-owned RNR components styled with Uniwind. Use these for
            product UI and branded interactions.
          </Text>
          <RnrCatalog />
        </ComponentSection>

        <ComponentSection title="QOP · chat primitives">
          <Text tone="secondary" variant="caption">
            Composable message, delivery, attachment, reply, typing, and
            composer states for peer conversations.
          </Text>
          <ChatCatalog />
        </ComponentSection>

        <ComponentSection title="QOP · native platform primitives">
          <Text tone="secondary" variant="caption">
            Expo UI controls reserved for settings and system-native
            presentation on SwiftUI and Jetpack Compose.
          </Text>
          <ExpoUICatalog onOpenSheet={() => setIsSheetPresented(true)} />
        </ComponentSection>

        <ComponentSection title="Typography">
          <Text variant="display">Display</Text>
          <Text variant="title">Title</Text>
          <Text variant="body">Default body text</Text>
          <Text variant="caption">Caption text</Text>
          <Text variant="label">Label text</Text>
          <Text variant="mono">const message = &quot;Code&quot;;</Text>
          <Text variant="link">Link text</Text>
          <Text variant="linkPrimary">Primary link text</Text>
          <Text tone="secondary" variant="body">
            Secondary text
          </Text>
        </ComponentSection>

        <ComponentSection title="Surfaces">
          <View className="flex-row gap-3">
            <Surface className="flex-1" variant="outline">
              <Text variant="caption">Default</Text>
            </Surface>
            <Surface className="flex-1" tone="element" variant="card">
              <Text variant="caption">Element</Text>
            </Surface>
          </View>
          <Surface tone="selected" variant="card">
            <Text variant="caption">Selected</Text>
          </Surface>
        </ComponentSection>

        <ComponentSection title="Hint rows">
          <HintRow title="Environment" hint="development" />
          <HintRow
            title="File"
            hint={<Text variant="mono">src/app/(tabs)/ui.tsx</Text>}
          />
        </ComponentSection>

        <ComponentSection title="Media">
          <View className="flex-row items-center gap-5">
            <Surface
              className="h-20 w-20 items-center justify-center"
              tone="element"
              variant="card"
            >
              <Image
                className="h-12 w-12"
                contentFit="contain"
                source={expoLogo}
              />
            </Surface>
            <View className="flex-1 gap-1">
              <Text variant="label">Expo Image</Text>
              <Text tone="secondary" variant="caption">
                Wrapped for Uniwind class names.
              </Text>
            </View>
          </View>
        </ComponentSection>

        <ComponentSection title="Actions">
          <ExternalLink href="https://docs.expo.dev" asChild>
            <Button className="w-full" variant="secondary">
              <Text>Open Expo docs</Text>
            </Button>
          </ExternalLink>
        </ComponentSection>

        <ComponentSection title="Motion">
          <View className="h-40 items-center justify-center overflow-hidden">
            <AnimatedIcon />
          </View>
        </ComponentSection>

        {process.env.EXPO_OS === "web" && (
          <ComponentSection title="Web badge">
            <WebBadge />
          </ComponentSection>
        )}
      </Screen>

      <ExpoBottomSheet
        isPresented={isSheetPresented}
        onDismiss={() => setIsSheetPresented(false)}
        snapPoints={["half", "full"]}
      >
        <Column className="p-6" spacing={12}>
          <ExpoText textStyle={{ fontSize: 20, fontWeight: "700" }}>
            Expo UI bottom sheet
          </ExpoText>
          <ExpoText>
            This sheet is backed by SwiftUI on iOS and Compose on Android.
          </ExpoText>
          <ExpoSpacer />
          <ExpoButton label="Done" onPress={() => setIsSheetPresented(false)} />
        </Column>
      </ExpoBottomSheet>
    </View>
  );
};

export default UIScreen;
