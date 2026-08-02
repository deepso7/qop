import type { LucideIcon, LucideProps } from "lucide-react-native";
import * as React from "react";
import { useColorScheme } from "react-native";
import { withUniwind } from "uniwind";

import { TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";

type IconProps = LucideProps & {
  as: LucideIcon;
} & React.RefAttributes<LucideIcon>;

const colorClassPattern =
  /(?:^|\s)text-(?<color>accent-foreground|card-foreground|destructive|foreground|muted-foreground|popover-foreground|primary|primary-foreground|red-500|secondary-foreground|white)(?=\s|$)/gu;

const iconColors = {
  dark: {
    "accent-foreground": "#fafafa",
    "card-foreground": "#fafafa",
    destructive: "#ff6467",
    foreground: "#ffffff",
    "muted-foreground": "#a3a3a3",
    "popover-foreground": "#fafafa",
    primary: "#e5e5e5",
    "primary-foreground": "#262626",
    "red-500": "#ef4444",
    "secondary-foreground": "#fafafa",
    white: "#ffffff",
  },
  light: {
    "accent-foreground": "#262626",
    "card-foreground": "#171717",
    destructive: "#dc2626",
    foreground: "#000000",
    "muted-foreground": "#737373",
    "popover-foreground": "#171717",
    primary: "#262626",
    "primary-foreground": "#fafafa",
    "red-500": "#ef4444",
    "secondary-foreground": "#262626",
    white: "#ffffff",
  },
} as const;

const IconImpl = ({ as: IconComponent, ...props }: IconProps) => (
  <IconComponent {...props} />
);

const StyledIcon = withUniwind(IconImpl, {
  size: {
    fromClassName: "className",
    styleProperty: "width",
  },
});

const Icon = ({ className, ...props }: IconProps) => {
  const textClass = React.useContext(TextClassContext);
  const colorScheme = useColorScheme() === "dark" ? "dark" : "light";
  const mergedClassName = cn("text-foreground size-5", textClass, className);
  const colorMatches = [...mergedClassName.matchAll(colorClassPattern)];
  const colorName = (colorMatches.at(-1)?.groups?.color ??
    "foreground") as keyof (typeof iconColors)[typeof colorScheme];

  return (
    <StyledIcon
      {...props}
      className={mergedClassName}
      color={props.color ?? iconColors[colorScheme][colorName]}
    />
  );
};

export { Icon };
