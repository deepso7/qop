import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { ArrowUp, Plus, Square } from "lucide-react-native";
import * as React from "react";
import type { Pressable } from "react-native";
import { TextInput, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

const chatComposerVariants = cva(
  "bg-background border-continuous rounded-bubble flex-row items-end gap-3",
  {
    defaultVariants: { variant: "default" },
    variants: {
      variant: {
        // Embedded in a screen or catalog that frames it already.
        bare: "",
        default: "border-border border p-2",
      },
    },
  }
);

const ChatComposer = ({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof View> &
  VariantProps<typeof chatComposerVariants>) => (
  <View
    className={cn(chatComposerVariants({ variant }), className)}
    {...props}
  />
);

type ChatComposerButtonProps = React.ComponentProps<typeof Pressable> & {
  kind?: "add" | "send" | "stop";
};

const composerButtonContent = {
  add: { icon: Plus, label: "Add attachment" },
  send: { icon: ArrowUp, label: "Send" },
  stop: { icon: Square, label: "Stop recording" },
} as const;

const ChatComposerButton = ({
  className,
  disabled,
  kind = "send",
  ...props
}: ChatComposerButtonProps) => {
  const { icon, label } = composerButtonContent[kind];

  return (
    <Button
      size="icon"
      variant={kind === "add" ? "secondary" : "default"}
      accessibilityLabel={label}
      accessibilityRole="button"
      className={cn(
        "size-11 shrink-0 items-center justify-center rounded-full",
        kind === "add" ? "bg-background-element" : "bg-primary",
        disabled && "bg-background-element opacity-100",
        className
      )}
      disabled={disabled}
      hitSlop={4}
      {...props}
    >
      <Icon
        as={icon}
        className={cn(
          "size-5",
          kind !== "add" && "text-primary-foreground",
          disabled && "text-foreground-secondary",
          kind === "stop" && "fill-primary-foreground size-3"
        )}
      />
    </Button>
  );
};

const ChatComposerInput = ({
  className,
  ...props
}: React.ComponentProps<typeof TextInput>) => (
  <TextInput
    className={cn(
      "bg-background-element text-foreground rounded-panel border-continuous max-h-40 min-h-11 flex-1 px-4 py-2.5 text-base leading-5",
      className
    )}
    multiline
    placeholder="Message"
    placeholderTextColorClassName="accent-muted-foreground"
    selectionColorClassName="accent-primary"
    textAlignVertical="center"
    {...props}
  />
);

// A static waveform: bar heights from 10 to 25pt.
const WAVEFORM = [
  "h-2.5",
  "h-4",
  "h-5.5",
  "h-3.25",
  "h-6.25",
  "h-2.75",
  "h-4.75",
  "h-3.5",
  "h-6",
  "h-3",
  "h-4.5",
];

type ChatRecordingProps = React.ComponentProps<typeof View> & {
  duration: string;
};

const ChatRecording = ({
  className,
  duration,
  ...props
}: ChatRecordingProps) => (
  <View
    className={cn(
      "bg-background-element h-11 flex-1 flex-row items-center gap-3 rounded-full px-4",
      className
    )}
    {...props}
  >
    <View className="bg-destructive size-2.5 rounded-sm" />
    <View className="min-w-0 flex-1 flex-row items-center gap-1">
      {WAVEFORM.map((height, index) => (
        <View
          className={cn(
            "bg-foreground-secondary min-w-1 flex-1 rounded-sm",
            height
          )}
          key={`${height}-${index}`}
        />
      ))}
    </View>
    <Text className="text-foreground-secondary text-sm tabular-nums" selectable>
      {duration}
    </Text>
  </View>
);

export { ChatComposer, ChatComposerButton, ChatComposerInput, ChatRecording };
