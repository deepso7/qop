import { scrollContentBackground } from "@expo/ui/swift-ui/modifiers";

// Hide SwiftUI Form's grouped background so the screen background shows
// through. Kept in an .ios file: the SwiftUI modifiers module loads a native
// module that does not exist on Android.
export const settingsFormModifiers = [scrollContentBackground("hidden")];
