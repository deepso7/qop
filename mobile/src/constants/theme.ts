/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import { Platform } from "react-native";

export const Colors = {
  dark: {
    background: "#0D1013",
    backgroundElement: "#181A1E",
    backgroundSelected: "#2B2C30",
    text: "#F2EEEA",
    textSecondary: "#999395",
  },
  light: {
    background: "#F2EEEA",
    backgroundElement: "#E5E0DE",
    backgroundSelected: "#CCC7C5",
    text: "#0D1013",
    textSecondary: "#575458",
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

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
