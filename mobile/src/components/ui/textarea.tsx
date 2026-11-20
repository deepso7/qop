import { useState } from "react";
import { Platform, TextInput } from "react-native";

import { cn } from "@/lib/utils";

const Textarea = ({
  className,
  multiline = true,
  // On web this sets the initial height; on native it sets the maximum height.
  numberOfLines = Platform.select({ native: 8, web: 2 }),
  placeholderTextColorClassName,
  onFocus,
  onBlur,
  ...props
}: React.ComponentProps<typeof TextInput> & React.RefAttributes<TextInput>) => {
  const [focused, setFocused] = useState(false);

  return (
    <TextInput
      className={cn(
        "text-foreground bg-input flex min-h-20 w-full flex-row rounded-md border border-transparent px-3 py-3 text-base md:text-sm",
        focused && "border-ring",
        Platform.select({
          web: "focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive field-sizing-content resize-y outline-none transition-[color,box-shadow] focus-visible:ring-[3px] disabled:cursor-not-allowed",
        }),
        props.editable === false && "opacity-50",
        className
      )}
      placeholderTextColorClassName={cn(
        "accent-muted-foreground",
        placeholderTextColorClassName
      )}
      multiline={multiline}
      onFocus={(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        onBlur?.(event);
      }}
      numberOfLines={numberOfLines}
      textAlignVertical="top"
      {...props}
    />
  );
};

export { Textarea };
