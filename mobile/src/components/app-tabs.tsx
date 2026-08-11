import { NativeTabs } from "expo-router/unstable-native-tabs";

import { useTheme } from "@/constants/theme";

const AppTabs = () => {
  const colors = useTheme();

  return (
    <NativeTabs
      backgroundColor={colors.background}
      indicatorColor={colors.backgroundElement}
      labelStyle={{
        default: { color: colors.textSecondary },
        selected: { color: colors.primary },
      }}
      rippleColor="transparent"
      tintColor={colors.primary}
    >
      <NativeTabs.Trigger name="chats">
        <NativeTabs.Trigger.Label>Chats</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          md="chat_bubble"
          sf={{ default: "bubble.left", selected: "bubble.left.fill" }}
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="explore">
        <NativeTabs.Trigger.Label>Explore</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          md="explore"
          sf={{ default: "safari", selected: "safari.fill" }}
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="components">
        <NativeTabs.Trigger.Label>Components</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          md="grid_view"
          sf={{ default: "square.grid.2x2", selected: "square.grid.2x2.fill" }}
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
};

export default AppTabs;
