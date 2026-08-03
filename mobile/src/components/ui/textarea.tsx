import { Platform, TextInput } from "react-native";

import { cn } from "@/lib/utils";

const Textarea = ({
  className,
  multiline = true,
  // On web this sets the initial height; on native it sets the maximum height.
  numberOfLines = Platform.select({ native: 8, web: 2 }),
  placeholderTextColorClassName,
  ...props
}: React.ComponentProps<typeof TextInput> & React.RefAttributes<TextInput>) => (
  <TextInput
    className={cn(
      "text-foreground border-input dark:bg-input/30 flex min-h-20 w-full flex-row rounded-md border bg-transparent px-3 py-3 text-base shadow-sm shadow-black/5 md:text-sm",
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
    numberOfLines={numberOfLines}
    textAlignVertical="top"
    {...props}
  />
);

export { Textarea };
