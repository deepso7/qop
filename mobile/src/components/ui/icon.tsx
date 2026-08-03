import type { LucideIcon, LucideProps } from "lucide-react-native";
import * as React from "react";
import { withUniwind } from "uniwind";

import { TextClassContext } from "@/components/ui/text";
import { useTheme } from "@/constants/theme";
import { cn } from "@/lib/utils";

type IconProps = LucideProps & {
  as: LucideIcon;
} & React.RefAttributes<LucideIcon>;

const colorClassPattern =
  /(?:^|\s)text-(?<color>accent-foreground|card-foreground|destructive|foreground|muted-foreground|popover-foreground|primary|primary-foreground|red-500|secondary-foreground|white)(?=\s|$)/gu;

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
  const theme = useTheme();
  const iconColors = {
    "accent-foreground": theme.accentForeground,
    "card-foreground": theme.cardForeground,
    destructive: theme.destructive,
    foreground: theme.text,
    "muted-foreground": theme.mutedForeground,
    "popover-foreground": theme.popoverForeground,
    primary: theme.primary,
    "primary-foreground": theme.primaryForeground,
    "red-500": theme.red500,
    "secondary-foreground": theme.secondaryForeground,
    white: theme.white,
  } as const;
  const mergedClassName = cn("text-foreground size-5", textClass, className);
  const colorMatches = [...mergedClassName.matchAll(colorClassPattern)];
  const colorName = (colorMatches.at(-1)?.groups?.color ??
    "foreground") as keyof typeof iconColors;

  return (
    <StyledIcon
      {...props}
      className={mergedClassName}
      color={props.color ?? iconColors[colorName]}
    />
  );
};

export { Icon };
