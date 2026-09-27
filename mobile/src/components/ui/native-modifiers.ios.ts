import {
  accessibilityAddTraits,
  accessibilityElement,
  accessibilityLabel,
  scrollContentBackground,
} from "@expo/ui/swift-ui/modifiers";

// SwiftUI modifiers for @expo/ui trees. Kept in an .ios file: the SwiftUI
// modifiers module loads a native module that does not exist on Android.

/** Hide SwiftUI Form's grouped background so the screen background shows. */
export const settingsFormModifiers = [scrollContentBackground("hidden")];

/** Make an icon-only pressable read as one named button to VoiceOver. */
export const accessibleButtonModifiers = (label: string) => [
  accessibilityElement("ignore"),
  accessibilityLabel(label),
  accessibilityAddTraits(["isButton"]),
];
