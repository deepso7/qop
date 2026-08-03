import type { TabTriggerSlotProps, TabListProps } from "expo-router/ui";
import { Tabs, TabList, TabTrigger, TabSlot } from "expo-router/ui";
import { SymbolView } from "expo-symbols";
import { Pressable, View } from "react-native";

import { useTheme } from "@/constants/theme";

import { ExternalLink } from "./external-link";
import { ThemedText } from "./themed-text";
import { ThemedView } from "./themed-view";

export const TabButton = ({
  children,
  isFocused,
  ...props
}: TabTriggerSlotProps) => (
  <Pressable {...props} className="min-h-11 justify-center active:opacity-70">
    <ThemedView
      className="min-h-11 justify-center rounded-2xl px-4"
      type={isFocused ? "backgroundSelected" : "backgroundElement"}
    >
      <ThemedText
        type="small"
        themeColor={isFocused ? "text" : "textSecondary"}
      >
        {children}
      </ThemedText>
    </ThemedView>
  </Pressable>
);

export const CustomTabList = (props: TabListProps) => {
  const colors = useTheme();

  return (
    <View
      {...props}
      className="absolute w-full flex-row items-center justify-center p-4"
    >
      <ThemedView
        className="max-w-3xl flex-grow flex-row items-center gap-2 rounded-4xl px-8 py-2"
        type="backgroundElement"
      >
        <ThemedText className="mr-auto" type="smallBold">
          Expo Starter
        </ThemedText>

        {props.children}

        <ExternalLink href="https://docs.expo.dev" asChild>
          <Pressable className="ml-4 min-h-11 flex-row items-center justify-center gap-1">
            <ThemedText type="link">Docs</ThemedText>
            <SymbolView
              tintColor={colors.text}
              name={{ ios: "arrow.up.right.square", web: "link" }}
              size={12}
            />
          </Pressable>
        </ExternalLink>
      </ThemedView>
    </View>
  );
};

const AppTabs = () => (
  <Tabs>
    <TabSlot style={{ height: "100%" }} />
    <TabList asChild>
      <CustomTabList>
        <TabTrigger name="home" href="/" asChild>
          <TabButton>Home</TabButton>
        </TabTrigger>
        <TabTrigger name="explore" href="/explore" asChild>
          <TabButton>Explore</TabButton>
        </TabTrigger>
        <TabTrigger name="components" href="/components" asChild>
          <TabButton>Components</TabButton>
        </TabTrigger>
      </CustomTabList>
    </TabList>
  </Tabs>
);

export default AppTabs;
