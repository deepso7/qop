import type { TabTriggerSlotProps, TabListProps } from "expo-router/ui";
import { Tabs, TabList, TabTrigger, TabSlot } from "expo-router/ui";
import { SymbolView } from "expo-symbols";
import { Pressable, View } from "react-native";

import { useTheme } from "@/constants/theme";

import { ExternalLink } from "./external-link";
import { Surface } from "./ui/surface";
import { Text } from "./ui/text";

export const TabButton = ({
  children,
  isFocused,
  ...props
}: TabTriggerSlotProps) => (
  <Pressable {...props} className="min-h-11 justify-center active:opacity-70">
    <Surface
      className="min-h-11 justify-center rounded-md px-4"
      tone={isFocused ? "selected" : "element"}
    >
      <Text
        className={isFocused ? undefined : "text-foreground-secondary"}
        variant="caption"
      >
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
        className="max-w-3xl grow flex-row items-center gap-2 rounded-2xl px-8 py-2"
        tone="element"
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

const AppTabs = () => (
  <Tabs>
    <TabSlot style={{ height: "100%" }} />
    <TabList asChild>
      <CustomTabList>
        <TabTrigger name="chats" href="/chats" asChild>
          <TabButton>Chats</TabButton>
        </TabTrigger>
        <TabTrigger name="ui" href="/ui" asChild>
          <TabButton>UI</TabButton>
        </TabTrigger>
      </CustomTabList>
    </TabList>
  </Tabs>
);

export default AppTabs;
