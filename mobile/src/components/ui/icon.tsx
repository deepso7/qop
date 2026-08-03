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
    "accent-foreground": "#f2eeea",
    "card-foreground": "#f2eeea",
    destructive: "#ff6467",
    foreground: "#f2eeea",
    "muted-foreground": "#999395",
    "popover-foreground": "#f2eeea",
    primary: "#b96c45",
    "primary-foreground": "#0d1013",
    "red-500": "#ef4444",
    "secondary-foreground": "#f2eeea",
    white: "#ffffff",
  },
  light: {
    "accent-foreground": "#0d1013",
    "card-foreground": "#0d1013",
    destructive: "#dc2626",
    foreground: "#0d1013",
    "muted-foreground": "#575458",
    "popover-foreground": "#0d1013",
    primary: "#b96c45",
    "primary-foreground": "#0d1013",
    "red-500": "#ef4444",
    "secondary-foreground": "#0d1013",
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
