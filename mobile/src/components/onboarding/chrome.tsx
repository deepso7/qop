import { useEffect, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
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

// Small uppercase mono label, the web's section label ("ABOUT", "GET QOP").
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

// The step headline: big, tight Paper Mono at normal weight, as on the web hero.
export const Title = ({ children }: { children: ReactNode }) => (
  <Text variant="heading">{children}</Text>
);

export const Lede = ({ children }: { children: ReactNode }) => (
  <Text className="max-w-md" variant="lead">
    {children}
  </Text>
);

// "← back" on the left, "01 / 03" with one pixel per step on the right.
const StepHeader = ({
  onBack,
  step,
}: {
  onBack?: () => void;
  step: number;
}) => (
  <View className="h-11 flex-row items-center justify-between">
    {onBack ? (
      <Pressable
        accessibilityLabel="Back"
        accessibilityRole="button"
        className="-ml-2 h-11 justify-center px-2"
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
            className={cn("size-2", i < step ? "bg-primary" : "bg-border")}
            key={i}
          />
        ))}
      </View>
      <Text tone="secondary" variant="tag">
        {String(step).padStart(2, "0")} / {String(STEP_COUNT).padStart(2, "0")}
      </Text>
    </View>
  </View>
);

export interface StepFrameProps {
  children: ReactNode;
  // Pinned under the scrolling body, above the keyboard.
  footer?: ReactNode;
  onBack?: () => void;
  // Omit for screens outside the numbered steps (welcome, errors).
  step?: number;
}

// Layout for every onboarding screen: header, scrolling body, pinned footer.
// The route wraps it in a KeyboardAvoidingView so the footer rides the keyboard.
export const StepFrame = ({
  children,
  footer,
  onBack,
  step,
}: StepFrameProps) => (
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
      className="flex-1"
      contentContainerClassName="grow gap-8 px-6 pt-8 pb-6"
      keyboardDismissMode={
        process.env.EXPO_OS === "ios" ? "interactive" : "on-drag"
      }
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
    {footer ? (
      <View className="pb-safe-offset-10 gap-3 px-6 pt-3">{footer}</View>
    ) : null}
  </Animated.View>
);

// One-line mono status under a field or action: a pixel light plus text.
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
        "size-2",
        tone === "error" && "bg-destructive",
        tone === "muted" && "bg-border",
        tone === "ok" && "bg-online"
      )}
    />
    <Text
      className="flex-1"
      selectable
      tone={tone === "error" ? "destructive" : "secondary"}
      variant="terminal"
    >
      {children}
    </Text>
  </View>
);

export type LogState = "active" | "done" | "failed" | "waiting";

// One line of a terminal-style progress log: a blinking cursor while active,
// otherwise a pixel coloured by state.
export const LogRow = ({
  label,
  state,
}: {
  label: string;
  state: LogState;
}) => (
  <View className="h-6 flex-row items-center gap-3">
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
    <Text tone="secondary" variant="caption">
      {slow
        ? "Still working. The registry can be slow, and it’s safe to wait."
        : "Keep qop open. This takes a few seconds."}
    </Text>
  );
};
