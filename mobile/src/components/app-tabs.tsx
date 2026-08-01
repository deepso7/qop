import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useColorScheme } from "react-native";

import exploreTabIcon from "@/assets/images/tabIcons/explore.png";
import homeTabIcon from "@/assets/images/tabIcons/home.png";
import { Colors } from "@/constants/theme";

const AppTabs = () => {
  const scheme = useColorScheme();
  const colors = Colors[scheme === "unspecified" ? "light" : scheme];

  return (
    <NativeTabs
      backgroundColor={colors.background}
      indicatorColor={colors.backgroundElement}
      labelStyle={{ selected: { color: colors.text } }}
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon src={homeTabIcon} renderingMode="template" />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="explore">
        <NativeTabs.Trigger.Label>Explore</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={exploreTabIcon}
          renderingMode="template"
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
