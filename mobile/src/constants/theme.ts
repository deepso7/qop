import { Platform } from "react-native";
import { useCSSVariable } from "uniwind";

// Runtime colors are defined in global.css and resolved here for native components.
export type ThemeColor =
  | "background"
  | "backgroundElement"
  | "backgroundSelected"
  | "text"
  | "textSecondary";

export const useTheme = () => {
  const [
    background,
    backgroundElement,
    backgroundSelected,
    text,
    textSecondary,
    border,
    primary,
    primaryForeground,
    accentForeground,
    cardForeground,
    mutedForeground,
    popoverForeground,
    secondaryForeground,
    destructive,
    white,
    red500,
    gradientStart,
    gradientEnd,
  ] = useCSSVariable([
    "--color-background",
    "--color-background-element",
    "--color-background-selected",
    "--color-foreground",
    "--color-foreground-secondary",
    "--color-border",
    "--color-primary",
    "--color-primary-foreground",
    "--color-accent-foreground",
    "--color-card-foreground",
    "--color-muted-foreground",
    "--color-popover-foreground",
    "--color-secondary-foreground",
    "--color-destructive",
    "--color-white",
    "--color-red-500",
    "--qop-orange-light",
    "--qop-orange-dark",
  ]) as string[];

  return {
    accentForeground,
    background,
    backgroundElement,
    backgroundSelected,
    border,
    cardForeground,
    destructive,
    gradientEnd,
    gradientStart,
    mutedForeground,
    popoverForeground,
    primary,
    primaryForeground,
    red500,
    secondaryForeground,
    text,
    textSecondary,
    white,
  } as const;
};

export const Fonts = Platform.select({
  default: {
    mono: "monospace",
    rounded: "normal",
    sans: "normal",
    serif: "serif",
  },
  ios: {
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: "ui-monospace",
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: "ui-rounded",
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: "system-ui",
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: "ui-serif",
  },
  web: {
    mono: "var(--font-mono)",
    rounded: "var(--font-rounded)",
    sans: "var(--font-display)",
    serif: "var(--font-serif)",
  },
});

export const Spacing = {
  five: 32,
  four: 24,
  half: 2,
  one: 4,
  six: 64,
  three: 16,
  two: 8,
} as const;

export const BottomTabInset = Platform.select({ android: 80, ios: 50 }) ?? 0;
export const MaxContentWidth = 800;
