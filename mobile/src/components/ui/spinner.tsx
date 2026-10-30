import { ActivityIndicator } from "react-native";

// Same tone names as Text's.
export const SPINNER_TONES = {
  // On a bg-primary fill, e.g. inside a Button.
  onPrimary: "accent-primary-foreground",
  secondary: "accent-foreground-secondary",
} as const;

export interface SpinnerProps {
  tone?: keyof typeof SPINNER_TONES;
}

// Small indeterminate spinner. Android renders Material 3's morphing
// LoadingIndicator instead (spinner.android.tsx).
export const Spinner = ({ tone = "secondary" }: SpinnerProps) => (
  <ActivityIndicator colorClassName={SPINNER_TONES[tone]} />
);

// For slots inside an @expo/ui tree (no Host of its own on Android).
export const NativeSpinner = Spinner;
