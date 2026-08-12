import { Platform, TextInput } from "react-native";

import { cn } from "@/lib/utils";

const Input = ({
  className,
  placeholderTextColorClassName,
  ...props
}: React.ComponentProps<typeof TextInput> & React.RefAttributes<TextInput>) => (
  <TextInput
    className={cn(
      "dark:bg-input/30 border-input bg-background text-foreground h-11 w-full min-w-0 rounded-md border px-3 text-base",
      props.editable === false &&
        cn(
          "opacity-50",
          Platform.select({
            web: "disabled:pointer-events-none disabled:cursor-not-allowed",
          })
        ),
      Platform.select({
        web: cn(
          "placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground outline-none transition-[color,box-shadow] md:text-sm",
          "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
          "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive"
        ),
      }),
      className
    )}
    placeholderTextColorClassName={cn(
      "accent-muted-foreground/50",
      placeholderTextColorClassName
    )}
    {...props}
  />
);

export { Input };
