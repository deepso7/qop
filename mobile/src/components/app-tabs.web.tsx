import type { TabTriggerSlotProps, TabListProps } from "expo-router/ui";
import { Tabs, TabList, TabTrigger, TabSlot } from "expo-router/ui";
import { SymbolView } from "expo-symbols";
import { Pressable, useColorScheme, View, StyleSheet } from "react-native";

import { Colors, MaxContentWidth, Spacing } from "@/constants/theme";

import { ExternalLink } from "./external-link";
import { ThemedText } from "./themed-text";
import { ThemedView } from "./themed-view";

const styles = StyleSheet.create({
  brandText: {
    marginRight: "auto",
  },
  externalPressable: {
    alignItems: "center",
    flexDirection: "row",
    gap: Spacing.one,
    justifyContent: "center",
    marginLeft: Spacing.three,
  },
  innerContainer: {
    alignItems: "center",
    borderRadius: Spacing.five,
    flexDirection: "row",
    flexGrow: 1,
    gap: Spacing.two,
    maxWidth: MaxContentWidth,
    paddingHorizontal: Spacing.five,
    paddingVertical: Spacing.two,
  },
  pressed: {
    opacity: 0.7,
  },
  tabButtonView: {
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
  },
  tabListContainer: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
    padding: Spacing.three,
    position: "absolute",
    width: "100%",
  },
});

export const TabButton = ({
  children,
  isFocused,
  ...props
}: TabTriggerSlotProps) => (
  <Pressable {...props} style={({ pressed }) => pressed && styles.pressed}>
    <ThemedView
      type={isFocused ? "backgroundSelected" : "backgroundElement"}
      style={styles.tabButtonView}
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
  const scheme = useColorScheme();
  const colors = Colors[scheme === "unspecified" ? "light" : scheme];

  return (
    <View {...props} style={styles.tabListContainer}>
      <ThemedView type="backgroundElement" style={styles.innerContainer}>
        <ThemedText type="smallBold" style={styles.brandText}>
          Expo Starter
        </ThemedText>

        {props.children}

        <ExternalLink href="https://docs.expo.dev" asChild>
          <Pressable style={styles.externalPressable}>
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
