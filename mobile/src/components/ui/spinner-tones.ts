// Shared by spinner.tsx and spinner.android.tsx. Lives apart because on
// Android "./spinner" resolves to spinner.android.tsx itself.

// Same tone names as Text's.
export const SPINNER_TONES = {
  // On a bg-primary fill, e.g. inside a Button.
  onPrimary: "accent-primary-foreground",
  secondary: "accent-foreground-secondary",
} as const;

export interface SpinnerProps {
  tone?: keyof typeof SPINNER_TONES;
}
