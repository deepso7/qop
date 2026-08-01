import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import expoLogo from "@/assets/images/expo-logo.png";
import { AnimatedIcon } from "@/components/animated-icon";
import { ExternalLink } from "@/components/external-link";
import { HintRow } from "@/components/hint-row";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { Collapsible } from "@/components/ui/collapsible";
import { Image } from "@/components/ui/image";
import { WebBadge } from "@/components/web-badge";
import { BottomTabInset, Spacing } from "@/constants/theme";

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

const ComponentsScreen = () => {
  const safeAreaInsets = useSafeAreaInsets();
  const contentInset = {
    bottom: safeAreaInsets.bottom + BottomTabInset + Spacing.three,
  };

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentInset={contentInset}
      contentContainerClassName="items-center px-5 pt-8 android:pt-safe-offset-5 android:pb-safe-offset-24 web:pt-24 web:pb-8"
    >
      <View className="w-full max-w-[720px] gap-7">
        <View className="gap-1 px-1 pb-1">
          <ThemedText type="subtitle">Components</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Shared primitives and their current states.
          </ThemedText>
        </View>

        <ComponentSection title="Typography">
          <ThemedText type="title">Title</ThemedText>
          <ThemedText type="subtitle">Subtitle</ThemedText>
          <ThemedText>Default body text</ThemedText>
          <ThemedText type="small">Small text</ThemedText>
          <ThemedText type="smallBold">Small bold text</ThemedText>
          <ThemedText type="code">const message = &quot;Code&quot;;</ThemedText>
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

        <ComponentSection title="Collapsible">
          <Collapsible title="Open this component">
            <ThemedText type="small">
              Collapsible content inherits the current light or dark theme.
            </ThemedText>
          </Collapsible>
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
    </ScrollView>
  );
};

export default ComponentsScreen;
