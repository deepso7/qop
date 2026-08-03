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
import { Platform, Pressable, View } from "react-native";
import type { LayoutChangeEvent } from "react-native";

import expoLogo from "@/assets/images/expo-logo.png";
import { AnimatedIcon } from "@/components/animated-icon";
import { ExternalLink } from "@/components/external-link";
import { HintRow } from "@/components/hint-row";
import { RnrCatalog } from "@/components/rnr-catalog";
import { Screen } from "@/components/screen";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { Button } from "@/components/ui/button";
import { Image } from "@/components/ui/image";
import { Text } from "@/components/ui/text";
import { WebBadge } from "@/components/web-badge";
import { useTheme } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";

const ExpoSettingsGroupHeight = Platform.OS === "android" ? 184 : 168;

const ComponentSection = ({
  children,
  title,
}: React.PropsWithChildren<{ title: string }>) => (
  <View className="gap-2">
    <ThemedText
      className="px-1 uppercase tracking-wider"
      type="code"
      themeColor="textSecondary"
    >
      {title}
    </ThemedText>
    <ThemedView className="gap-4 rounded-2xl border border-background-selected p-4">
      {children}
    </ThemedView>
  </View>
);

const ExpoNativePreview = ({
  children,
  height,
  inset = false,
  seedColor,
}: {
  children: React.ReactNode | ((contentWidth: number) => React.ReactNode);
  height: number;
  inset?: boolean;
  seedColor?: string;
}) => {
  const [contentWidth, setContentWidth] = useState(0);
  const colorScheme = useColorScheme() === "dark" ? "dark" : "light";

  const handleLayout = ({ nativeEvent }: LayoutChangeEvent) => {
    const nextWidth = nativeEvent.layout.width;
    setContentWidth((currentWidth) =>
      currentWidth === nextWidth ? currentWidth : nextWidth
    );
  };

  return (
    <View className="overflow-hidden rounded-xl bg-background-element/50">
      <View className={inset ? "px-4 py-3" : undefined}>
        <View onLayout={handleLayout}>
          <ExpoHost
            colorScheme={colorScheme}
            ignoreSafeArea="all"
            seedColor={seedColor}
            style={{ height, width: "100%" }}
          >
            {typeof children === "function"
              ? contentWidth > 0 && children(contentWidth)
              : children}
          </ExpoHost>
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
        <ThemedText type="smallBold">Platform controls</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Native rendering is intentional for settings and system preferences.
        </ThemedText>
        <ExpoNativePreview height={184} inset seedColor={theme.primary}>
          {(contentWidth) => (
            <ExpoColumn spacing={16} style={{ width: contentWidth }}>
              <ExpoRow alignment="center" style={{ width: contentWidth }}>
                <ExpoText textStyle={{ color: theme.text }}>
                  Native controls
                </ExpoText>
                <ExpoSpacer flexible />
                <ExpoSwitch
                  onValueChange={setIsSwitchedOn}
                  value={isSwitchedOn}
                />
              </ExpoRow>
              <ExpoRow alignment="center" style={{ width: contentWidth }}>
                <ExpoText textStyle={{ color: theme.textSecondary }}>
                  Disabled switch
                </ExpoText>
                <ExpoSpacer flexible />
                <ExpoSwitch
                  disabled
                  onValueChange={setIsSwitchedOn}
                  value={false}
                />
              </ExpoRow>
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
            </ExpoColumn>
          )}
        </ExpoNativePreview>
      </View>

      <View className="gap-2">
        <ThemedText type="smallBold">Native settings group</ThemedText>
        <ExpoNativePreview height={ExpoSettingsGroupHeight}>
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
        <ThemedText type="smallBold">Native presentation</ThemedText>
        <Button onPress={onOpenSheet} variant="outline">
          <Text>Open native bottom sheet</Text>
        </Button>
      </View>
    </View>
  );
};

const ComponentsScreen = () => {
  const [isSheetPresented, setIsSheetPresented] = useState(false);

  return (
    <View className="flex-1 bg-background">
      <Screen contentContainerClassName="items-center px-5 pt-8 web:pt-24">
        <View className="w-full max-w-3xl gap-7">
          <View className="gap-1 px-1 pb-1">
            <ThemedText type="subtitle">Components</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              Shared primitives and their current states.
            </ThemedText>
          </View>

          <ComponentSection title="QOP · branded primitives">
            <ThemedText type="small" themeColor="textSecondary">
              Source-owned RNR components styled with Uniwind. Use these for
              product UI and branded interactions.
            </ThemedText>
            <RnrCatalog />
          </ComponentSection>

          <ComponentSection title="QOP · native platform primitives">
            <ThemedText type="small" themeColor="textSecondary">
              Expo UI controls reserved for settings and system-native
              presentation on SwiftUI and Jetpack Compose.
            </ThemedText>
            <ExpoUICatalog onOpenSheet={() => setIsSheetPresented(true)} />
          </ComponentSection>

          <ComponentSection title="Typography">
            <ThemedText type="title">Title</ThemedText>
            <ThemedText type="subtitle">Subtitle</ThemedText>
            <ThemedText>Default body text</ThemedText>
            <ThemedText type="small">Small text</ThemedText>
            <ThemedText type="smallBold">Small bold text</ThemedText>
            <ThemedText type="code">
              const message = &quot;Code&quot;;
            </ThemedText>
            <ThemedText type="link">Link text</ThemedText>
            <ThemedText type="linkPrimary">Primary link text</ThemedText>
            <ThemedText themeColor="textSecondary">Secondary text</ThemedText>
          </ComponentSection>

          <ComponentSection title="Surfaces">
            <View className="flex-row gap-3">
              <ThemedView className="flex-1 rounded-xl border border-background-selected p-4">
                <ThemedText type="small">Default</ThemedText>
              </ThemedView>
              <ThemedView
                className="flex-1 rounded-xl p-4"
                type="backgroundElement"
              >
                <ThemedText type="small">Element</ThemedText>
              </ThemedView>
            </View>
            <ThemedView className="rounded-2xl p-4" type="backgroundSelected">
              <ThemedText type="small">Selected</ThemedText>
            </ThemedView>
          </ComponentSection>

          <ComponentSection title="Hint rows">
            <HintRow title="Environment" hint="development" />
            <HintRow
              title="File"
              hint={<ThemedText type="code">src/app/components.tsx</ThemedText>}
            />
          </ComponentSection>

          <ComponentSection title="Media">
            <View className="flex-row items-center gap-5">
              <ThemedView
                className="h-20 w-20 items-center justify-center rounded-2xl"
                type="backgroundElement"
              >
                <Image
                  className="h-12 w-12"
                  contentFit="contain"
                  source={expoLogo}
                />
              </ThemedView>
              <View className="flex-1 gap-1">
                <ThemedText type="smallBold">Expo Image</ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  Wrapped for Uniwind class names.
                </ThemedText>
              </View>
            </View>
          </ComponentSection>

          <ComponentSection title="Actions">
            <ExternalLink href="https://docs.expo.dev" asChild>
              <Pressable className="items-center rounded-xl bg-background-selected px-5 py-3 active:opacity-70">
                <ThemedText type="smallBold">Open Expo docs</ThemedText>
              </Pressable>
            </ExternalLink>
          </ComponentSection>

          <ComponentSection title="Motion">
            <View className="h-40 items-center justify-center overflow-hidden">
              <AnimatedIcon />
            </View>
          </ComponentSection>

          {Platform.OS === "web" && (
            <ComponentSection title="Web badge">
              <WebBadge />
            </ComponentSection>
          )}
        </View>
      </Screen>

      <ExpoBottomSheet
        isPresented={isSheetPresented}
        onDismiss={() => setIsSheetPresented(false)}
        snapPoints={["half", "full"]}
      >
        <ExpoColumn spacing={12} style={{ padding: 24 }}>
          <ExpoText textStyle={{ fontSize: 20, fontWeight: "700" }}>
            Expo UI bottom sheet
          </ExpoText>
          <ExpoText>
            This sheet is backed by SwiftUI on iOS and Compose on Android.
          </ExpoText>
          <ExpoSpacer />
          <ExpoButton label="Done" onPress={() => setIsSheetPresented(false)} />
        </ExpoColumn>
      </ExpoBottomSheet>
    </View>
  );
};

export default ComponentsScreen;
