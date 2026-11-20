import { useEffect, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  ReduceMotion,
} from "react-native-reanimated";

import { Cursor, PixelDot } from "@/components/pixel/cursor";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

export const STEP_COUNT = 3;

const enter = FadeIn.duration(180).reduceMotion(ReduceMotion.System);
const exit = FadeOut.duration(100).reduceMotion(ReduceMotion.System);

// Small mono section label.
export const Eyebrow = ({
  children,
  tone = "secondary",
}: {
  children: ReactNode;
  tone?: ComponentProps<typeof Text>["tone"];
}) => (
  <Text tone={tone} variant="eyebrow">
    {children}
  </Text>
);

// The display scale shared with desktop onboarding.
export const Title = ({ children }: { children: ReactNode }) => (
  <Text maxFontSizeMultiplier={2} variant="display">
    {children}
  </Text>
);

export const Lede = ({ children }: { children: ReactNode }) => (
  <Text className="max-w-md" variant="lead">
    {children}
  </Text>
);

// "← back" on the left, "01 / 03" with one dot per step on the right.
const StepHeader = ({
  onBack,
  step,
}: {
  onBack?: () => void;
  step: number;
}) => (
  <View className="min-h-11 flex-row items-center justify-between">
    {onBack ? (
      <Pressable
        accessibilityLabel="Back"
        accessibilityRole="button"
        className="-ml-2 min-h-11 justify-center px-2"
        hitSlop={8}
        onPress={onBack}
      >
        {({ pressed }) => (
          <Text tone={pressed ? "link" : "secondary"} variant="terminal">
            ← back
          </Text>
        )}
      </Pressable>
    ) : (
      <View />
    )}
    <View
      accessibilityLabel={`Step ${step} of ${STEP_COUNT}`}
      accessible
      className="flex-row items-center gap-3"
    >
      <View className="flex-row gap-1">
        {Array.from({ length: STEP_COUNT }, (_, i) => (
          <View
            className={cn(
              "size-2 rounded-full",
              i < step ? "bg-primary" : "bg-border"
            )}
            key={i}
          />
        ))}
      </View>
      <Text maxFontSizeMultiplier={2} tone="secondary" variant="tag">
        {String(step).padStart(2, "0")} / {String(STEP_COUNT).padStart(2, "0")}
      </Text>
    </View>
  </View>
);

export interface StepFrameProps {
  children: ReactNode;
  // Pinned below the body at standard text sizes; scrolls at accessibility sizes.
  footer?: ReactNode;
  onBack?: () => void;
  // Omit for screens outside the numbered steps (welcome, errors).
  step?: number;
}

// Shared onboarding header, scrolling body and responsive footer.
export const StepFrame = ({
  children,
  footer,
  onBack,
  step,
}: StepFrameProps) => {
  const { fontScale } = useWindowDimensions();
  const scrollFooter = fontScale >= 2;

  return (
    <Animated.View
      className="pt-safe-or-4 flex-1"
      entering={enter}
      exiting={exit}
    >
      {step === undefined ? null : (
        <View className="px-6">
          <StepHeader onBack={onBack} step={step} />
        </View>
      )}
      <ScrollView
        automaticallyAdjustKeyboardInsets={scrollFooter}
        className="flex-1"
        contentContainerClassName={cn(
          "grow gap-8 px-6 pt-8 pb-6",
          scrollFooter && "pb-safe-offset-10"
        )}
        keyboardDismissMode={
          process.env.EXPO_OS === "ios" ? "interactive" : "on-drag"
        }
        keyboardShouldPersistTaps="handled"
      >
        {children}
        {scrollFooter && footer ? (
          <View className="gap-3 pt-3">{footer}</View>
        ) : null}
      </ScrollView>
      {!scrollFooter && footer ? (
        <View className="pb-safe-offset-10 gap-3 px-6 pt-3">{footer}</View>
      ) : null}
    </Animated.View>
  );
};

// Field feedback pairs a status light with supporting copy.
export const StatusLine = ({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "error" | "muted" | "ok";
}) => (
  <View className="flex-row items-center gap-2">
    <View
      className={cn(
        "size-2 rounded-full",
        tone === "error" && "bg-destructive",
        tone === "muted" && "bg-border",
        tone === "ok" && "bg-online"
      )}
    />
    <Text
      className="flex-1"
      selectable
      tone={tone === "error" ? "destructive" : "secondary"}
      variant="helper"
    >
      {children}
    </Text>
  </View>
);

export type LogState = "active" | "done" | "failed" | "waiting";

// One line of a terminal-style progress log: a blinking cursor while active,
// otherwise a dot coloured by state.
export const LogRow = ({
  label,
  state,
}: {
  label: string;
  state: LogState;
}) => (
  <View className="min-h-6 flex-row items-center gap-3">
    <View className="w-2 items-center">
      {state === "active" ? (
        <Cursor className="bg-primary" />
      ) : (
        <PixelDot
          className={cn(
            state === "done" && "bg-primary",
            state === "failed" && "bg-destructive",
            state === "waiting" && "bg-border"
          )}
        />
      )}
    </View>
    <Text
      tone={state === "waiting" ? "secondary" : "default"}
      variant="terminal"
    >
      {label}
    </Text>
  </View>
);

// How long a wait can run before the caption admits it's slow.
const SLOW_AFTER_MS = 15_000;

// The note under a progress log: a time estimate first, then an honest
// "still working" once the wait runs long.
export const WaitCaption = () => {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);

    return () => clearTimeout(timer);
  }, []);

  return (
    <Text tone="secondary" variant="helper">
      {slow
        ? "Still working. The registry can be slow, and it’s safe to wait."
        : "Keep qop open. This takes a few seconds."}
    </Text>
  );
};
