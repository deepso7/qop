import { Search, X } from "lucide-react-native";
import * as React from "react";
import { Pressable, TextInput, View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

interface ChatSearchProps extends Omit<
  React.ComponentProps<typeof TextInput>,
  "onChangeText"
> {
  onChangeText?: (value: string) => void;
}

const ChatSearch = React.forwardRef<TextInput, ChatSearchProps>(
  (
    {
      className,
      defaultValue,
      onChangeText,
      placeholder = "Search chats",
      value,
      ...props
    },
    ref
  ) => {
    const [uncontrolledValue, setUncontrolledValue] = React.useState(
      defaultValue ?? ""
    );
    const isControlled = value !== undefined;
    const currentValue = isControlled ? value : uncontrolledValue;
    const canClear = !isControlled || typeof onChangeText === "function";
    const hasClearableValue = canClear && currentValue.length > 0;

    const handleChangeText = React.useCallback(
      (nextValue: string) => {
        if (!isControlled) {
          setUncontrolledValue(nextValue);
        }
        onChangeText?.(nextValue);
      },
      [isControlled, onChangeText]
    );

    const handleClear = React.useCallback(() => {
      handleChangeText("");
    }, [handleChangeText]);

    return (
      <View
        className={cn(
          "h-11 flex-row items-center gap-2 rounded-[14px] bg-background-element px-3",
          className
        )}
        style={{ borderCurve: "continuous" }}
      >
        <Icon as={Search} className="size-[18px] text-foreground-secondary" />
        <TextInput
          ref={ref}
          accessibilityLabel="Search chats"
          autoCapitalize="none"
          autoCorrect={false}
          className="min-w-0 flex-1 py-0 text-[16px] leading-5 text-foreground"
          clearButtonMode="never"
          onChangeText={handleChangeText}
          placeholder={placeholder}
          placeholderTextColorClassName="accent-muted-foreground/70"
          returnKeyType="search"
          selectionColorClassName="accent-primary"
          value={currentValue}
          {...props}
        />
        {hasClearableValue ? (
          <Pressable
            accessibilityLabel="Clear search"
            accessibilityRole="button"
            className="size-7 items-center justify-center rounded-full bg-background-selected active:opacity-70"
            hitSlop={6}
            onPress={handleClear}
          >
            <Icon as={X} className="size-3.5 text-foreground-secondary" />
          </Pressable>
        ) : null}
      </View>
    );
  }
);

ChatSearch.displayName = "ChatSearch";

export { ChatSearch };
export type { ChatSearchProps };
