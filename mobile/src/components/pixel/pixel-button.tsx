import { Pressable } from "react-native";
import type { PressableProps } from "react-native";

import { Cursor } from "@/components/pixel/cursor";
import { RoundedSurface } from "@/components/ui/rounded-surface";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

type PixelButtonVariant = "primary" | "quiet";

export type PixelButtonProps = Omit<PressableProps, "children"> & {
  // Shows a blinking cursor after the label and ignores presses.
  busy?: boolean;
  className?: string;
  label: string;
  // A glyph after the label, e.g. "→". Hidden while busy.
  trailing?: string;
  variant?: PixelButtonVariant;
};

// The main onboarding action, with a quiet alternative.
export const PixelButton = ({
  busy = false,
  className,
  disabled,
  label,
  trailing,
  variant = "primary",
  ...props
}: PixelButtonProps) => {
  const inactive = Boolean(disabled) || busy;
  const primary = variant === "primary";

  return (
    <Pressable
      // Busy goes in the label: React Native on Android never clears a
      // `busy` accessibility state once set, so the button would keep saying it.
      accessibilityLabel={busy ? `${label}, working` : label}
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive }}
      className={cn(inactive && !busy && "opacity-40", className)}
      disabled={inactive}
      {...props}
    >
      {({ pressed }) => {
        const pressedTone = primary ? "onPrimary" : "link";
        const restingTone = primary ? "onPrimary" : "secondary";
        const tone = pressed ? pressedTone : restingTone;

        return (
          <RoundedSurface
            className={primary ? "h-12" : "h-11"}
            variant={primary ? "primary" : "quiet"}
            pressed={pressed}
          >
            <Text tone={tone} variant="action">
              {label}
            </Text>
            {busy ? (
              <Cursor
                className={
                  primary ? "bg-background" : "bg-foreground-secondary"
                }
              />
            ) : null}
            {trailing && !busy ? (
              <Text tone={tone} variant="action">
                {trailing}
              </Text>
            ) : null}
          </RoundedSurface>
        );
      }}
    </Pressable>
  );
};
