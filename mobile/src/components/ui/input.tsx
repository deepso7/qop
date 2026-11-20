import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { useState } from "react";
import { Platform, TextInput } from "react-native";

import { cn } from "@/lib/utils";

const inputVariants = cva(
  cn(
    "border-continuous bg-input text-foreground min-h-12 w-full min-w-0 rounded-md border border-transparent px-3 py-3 font-sans text-base",
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
        // Pair with a taller minimum height for a screen's primary field.
        lg: "rounded-md px-4 text-lg",
      },
      variant: {
        default: "",
        // A filled input well.
        filled: "bg-input",
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
  onFocus,
  onBlur,
  ...props
}: InputProps) => {
  const [focused, setFocused] = useState(false);

  return (
    <TextInput
      className={cn(
        inputVariants({ size, variant }),
        focused && "border-ring",
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
        "accent-faint",
        placeholderTextColorClassName
      )}
      onFocus={(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        onBlur?.(event);
      }}
      selectionColorClassName="accent-primary"
      {...props}
    />
  );
};

export { Input, inputVariants };
