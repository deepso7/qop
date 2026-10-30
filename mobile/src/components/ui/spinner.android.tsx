import { Host } from "@expo/ui";
import { LoadingIndicator } from "@expo/ui/jetpack-compose";
import { size } from "@expo/ui/jetpack-compose/modifiers";
import type { ColorValue } from "react-native";
import { withUniwind } from "uniwind";

import { SPINNER_TONES } from "./spinner";
import type { SpinnerProps } from "./spinner";

// The morphing shape is inset in its box, so this reads like ActivityIndicator "small".
const SIZE = 24;

const Indicator = withUniwind(
  ({ color }: { color?: ColorValue }) => (
    <LoadingIndicator color={color} modifiers={[size(SIZE, SIZE)]} />
  ),
  { color: { fromClassName: "colorClassName", styleProperty: "accentColor" } }
);

// For slots inside an @expo/ui tree, which already has a Host.
export const NativeSpinner = ({ tone = "secondary" }: SpinnerProps) => (
  <Indicator colorClassName={SPINNER_TONES[tone]} />
);

// Material 3 Expressive loading indicator (morphing shapes).
export const Spinner = (props: SpinnerProps) => (
  <Host matchContents>
    <NativeSpinner {...props} />
  </Host>
);
