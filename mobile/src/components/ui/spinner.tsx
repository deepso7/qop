import { ActivityIndicator } from "react-native";

import { SPINNER_TONES } from "./spinner-tones";
import type { SpinnerProps } from "./spinner-tones";

// Small indeterminate spinner. Android renders Material 3's morphing
// LoadingIndicator instead (spinner.android.tsx).
export const Spinner = ({ tone = "secondary" }: SpinnerProps) => (
  <ActivityIndicator colorClassName={SPINNER_TONES[tone]} />
);

// For slots inside an @expo/ui tree (no Host of its own on Android).
export const NativeSpinner = Spinner;
