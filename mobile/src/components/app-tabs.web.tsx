import type { TabTriggerSlotProps, TabListProps } from "expo-router/ui";
import { Tabs, TabList, TabTrigger, TabSlot } from "expo-router/ui";
import { SymbolView } from "expo-symbols";
import type { RefAttributes } from "react";
import { Pressable, View } from "react-native";
import type { ViewInstance } from "react-native";
import { withUniwind } from "uniwind";

import { useTheme } from "@/constants/theme";

import { ExternalLink } from "./external-link";
import { Surface } from "./ui/surface";
import { Text } from "./ui/text";

// expo-router still types the slot ref as the `View` component; RN's strict
// API wants the host instance, which is what TabTrigger actually passes.
type TabButtonProps = Omit<TabTriggerSlotProps, "ref"> &
  RefAttributes<ViewInstance>;

export const TabButton = ({
  children,
  isFocused,
  ...props
}: TabButtonProps) => (
  <Pressable {...props} className="min-h-11 justify-center active:opacity-70">
    <Surface
      className="min-h-11 justify-center"
      tone={isFocused ? "selected" : "element"}
      variant="chip"
    >
      <Text tone={isFocused ? "default" : "secondary"} variant="caption">
        {children}
      </Text>
    </Surface>
  </Pressable>
);

export const CustomTabList = (props: TabListProps) => {
  const colors = useTheme();

  return (
    <View
      {...props}
      className="absolute w-full flex-row items-center justify-center p-4"
    >
      <Surface
        className="max-w-3xl grow flex-row items-center"
        tone="element"
        variant="toolbar"
      >
        <Text className="mr-auto" variant="label">
          qop
        </Text>

        {props.children}

        <ExternalLink href="https://docs.expo.dev" asChild>
          <Pressable className="ml-4 min-h-11 flex-row items-center justify-center gap-1">
            <Text variant="link">Docs</Text>
            <SymbolView
              tintColor={colors.text}
              name={{ ios: "arrow.up.right.square", web: "link" }}
              size={12}
            />
          </Pressable>
        </ExternalLink>
      </Surface>
    </View>
  );
};

// TabSlot only takes `style`; wrap it so layout can come from a class.
const StyledTabSlot = withUniwind(TabSlot);

const AppTabs = () => (
  <Tabs>
    <StyledTabSlot className="h-full" />
    <TabList asChild>
      <CustomTabList>
        <TabTrigger name="chats" href="/chats" asChild>
          <TabButton>Chats</TabButton>
        </TabTrigger>
        <TabTrigger name="ui" href="/ui" asChild>
          <TabButton>UI</TabButton>
        </TabTrigger>
        <TabTrigger name="profile" href="/profile" asChild>
          <TabButton>Profile</TabButton>
        </TabTrigger>
      </CustomTabList>
    </TabList>
  </Tabs>
);

export default AppTabs;
