import { ArrowUp, Plus, Square } from "lucide-react-native";
import * as React from "react";
import { Pressable, TextInput, View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

const ChatComposer = ({
  className,
  style,
  ...props
}: React.ComponentProps<typeof View>) => (
  <View
    className={cn(
      "border-border bg-background flex-row items-end gap-3 rounded-[22px] border p-2",
      className
    )}
    style={[{ borderCurve: "continuous" }, style]}
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
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      className={cn(
        "size-11 shrink-0 items-center justify-center rounded-full",
        kind === "add" ? "bg-background-element" : "bg-primary",
        disabled && "opacity-35",
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
          kind === "stop" && "fill-primary-foreground size-3"
        )}
      />
    </Pressable>
  );
};

const ChatComposerInput = ({
  className,
  ...props
}: React.ComponentProps<typeof TextInput>) => (
  <TextInput
    className={cn(
      "bg-background-element text-foreground min-h-11 flex-1 rounded-[20px] px-4 py-2.5 text-base leading-5",
      className
    )}
    multiline
    placeholder="Message"
    placeholderTextColorClassName="accent-muted-foreground/60"
    textAlignVertical="center"
    {...props}
  />
);

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
      {[10, 16, 22, 13, 25, 11, 19, 14, 24, 12, 18].map((height, index) => (
        <View
          className="bg-foreground-secondary min-w-1 flex-1 rounded-sm"
          key={`${height}-${index}`}
          style={{ height }}
        />
      ))}
    </View>
    <Text
      className="text-foreground-secondary text-sm"
      selectable
      style={{ fontVariant: ["tabular-nums"] }}
    >
      {duration}
    </Text>
  </View>
);

export { ChatComposer, ChatComposerButton, ChatComposerInput, ChatRecording };
