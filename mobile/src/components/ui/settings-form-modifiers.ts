import type { FieldGroup } from "@expo/ui";
import type { ComponentProps } from "react";

// Android and web settings forms need no extra modifiers; see the .ios file.
export const settingsFormModifiers: ComponentProps<
  typeof FieldGroup
>["modifiers"] = [];
