import * as TogglePrimitiveModule from "@rn-primitives/toggle";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import * as React from "react";
import { Platform } from "react-native";

import { Icon } from "@/components/ui/icon";
import { TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";

const TogglePrimitive = { ...TogglePrimitiveModule };
const toggleHitSlop = { default: 0, lg: 0, sm: 6 } as const;
const toggleTextSizes = {
  default: "text-sm",
  lg: "text-base",
  sm: "text-xs",
} as const;

const toggleVariants = cva(
  cn(
    "active:bg-muted group flex flex-row items-center justify-center gap-2 rounded-md",
    Platform.select({
      web: "hover:bg-muted hover:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive inline-flex cursor-default whitespace-nowrap outline-none transition-[color,box-shadow] focus-visible:ring-[3px] disabled:pointer-events-none [&_svg]:pointer-events-none",
    })
  ),
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "h-11 min-w-11 px-2.5",
        lg: "h-12 min-w-12 px-3",
        sm: "h-8 min-w-8 px-2",
      },
      variant: {
        default: "bg-transparent",
        outline: cn(
          "border-input active:bg-accent border bg-transparent",
          Platform.select({
            web: "hover:bg-accent hover:text-accent-foreground",
          })
        ),
      },
    },
  }
);

const Toggle = ({
  className,
  hitSlop,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> &
  VariantProps<typeof toggleVariants>) => {
  const textClassName = cn(
    "text-foreground font-medium",
    toggleTextSizes[size ?? "default"],
    props.pressed
      ? "text-accent-foreground"
      : Platform.select({ web: "group-hover:text-muted-foreground" }),
    className
  );

  return (
    <TextClassContext.Provider value={textClassName}>
      <TogglePrimitive.Root
        className={cn(
          toggleVariants({ size, variant }),
          props.disabled && "opacity-50",
          props.pressed && "bg-accent",
          className
        )}
        hitSlop={hitSlop ?? toggleHitSlop[size ?? "default"]}
        {...props}
      />
    </TextClassContext.Provider>
  );
};

const ToggleIcon = ({
  className,
  ...props
}: React.ComponentProps<typeof Icon>) => {
  const textClass = React.useContext(TextClassContext);
  return (
    <Icon className={cn("size-4 shrink-0", textClass, className)} {...props} />
  );
};

export { Toggle, ToggleIcon, toggleTextSizes, toggleVariants };
