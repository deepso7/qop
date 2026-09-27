import type { FieldGroup } from "@expo/ui";
import type { ComponentProps } from "react";

// Android and web need none of the SwiftUI modifiers; see the .ios file.
// On Android, name icon-only buttons with Icon's `accessibilityLabel`.
type Modifiers = ComponentProps<typeof FieldGroup>["modifiers"];

export const settingsFormModifiers: Modifiers = [];

export const accessibleButtonModifiers = (_label: string): Modifiers => [];
