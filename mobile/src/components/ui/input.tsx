import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { Platform, TextInput } from "react-native";

import { cn } from "@/lib/utils";

const inputVariants = cva(
  cn(
    "dark:bg-input/30 border-input bg-background text-foreground h-11 w-full min-w-0 rounded-md border px-3 text-base",
    Platform.select({
      web: cn(
        "placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground transition outline-none md:text-sm",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive"
      ),
    })
  ),
  {
    defaultVariants: { size: "default", variant: "default" },
    variants: {
      size: {
        default: "",
        // Pair with a taller height (e.g. h-14) for a screen's primary field.
        lg: "rounded-xl px-4 text-lg",
      },
      variant: {
        default: "",
        // Sits on the page as a filled well rather than an outlined box.
        filled:
          "border-border bg-background-element dark:bg-background-element",
      },
    },
  }
);

type InputProps = React.ComponentProps<typeof TextInput> &
  React.RefAttributes<TextInput> &
  VariantProps<typeof inputVariants>;

const Input = ({
  className,
  placeholderTextColorClassName,
  size,
  variant,
  ...props
}: InputProps) => (
  <TextInput
    className={cn(
      inputVariants({ size, variant }),
      props.editable === false &&
        cn(
          "opacity-50",
          Platform.select({
            web: "disabled:pointer-events-none disabled:cursor-not-allowed",
          })
        ),
      className
    )}
    placeholderTextColorClassName={cn(
      "accent-muted-foreground",
      placeholderTextColorClassName
    )}
    selectionColorClassName="accent-primary"
    {...props}
  />
);

export { Input, inputVariants };
