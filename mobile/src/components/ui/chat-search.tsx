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
  // oxlint-disable-next-line eslint/prefer-arrow-callback -- The named render function improves DevTools output.
  function ChatSearch(
    {
      className,
      defaultValue,
      onChangeText,
      placeholder = "Search chats",
      value,
      ...props
    },
    ref
  ) {
    const [uncontrolledValue, setUncontrolledValue] = React.useState(
      defaultValue ?? ""
    );
    const isControlled = value !== undefined;
    const currentValue = isControlled ? value : uncontrolledValue;
    const canClear = !isControlled || onChangeText !== undefined;
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
          "bg-background-element h-11 flex-row items-center gap-2 rounded-[14px] px-3",
          className
        )}
        style={{ borderCurve: "continuous" }}
      >
        <Icon as={Search} className="text-foreground-secondary size-[18px]" />
        <TextInput
          ref={ref}
          accessibilityLabel="Search chats"
          autoCapitalize="none"
          autoCorrect={false}
          className="text-foreground min-w-0 flex-1 py-0 text-[16px] leading-5"
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
            className="bg-background-selected size-7 items-center justify-center rounded-full active:opacity-70"
            hitSlop={6}
            onPress={handleClear}
          >
            <Icon as={X} className="text-foreground-secondary size-3.5" />
          </Pressable>
        ) : null}
      </View>
    );
  }
);

ChatSearch.displayName = "ChatSearch";

export { ChatSearch };
export type { ChatSearchProps };
