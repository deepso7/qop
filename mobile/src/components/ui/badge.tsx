import { Slot } from "@rn-primitives/slot";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { useMemo } from "react";
import { Platform, View } from "react-native";

import { TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  cn(
    "border-border group shrink-0 flex-row items-center justify-center gap-1 overflow-hidden rounded-full border px-2 py-0.5",
    Platform.select({
      web: "focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive w-fit whitespace-nowrap transition-[color,box-shadow] focus-visible:ring-[3px] [&>svg]:pointer-events-none [&>svg]:size-3",
    })
  ),
  {
    defaultVariants: {
      variant: "default",
    },
    variants: {
      variant: {
        default: cn(
          "bg-primary border-transparent",
          Platform.select({ web: "[a&]:hover:bg-primary/90" })
        ),
        destructive: cn(
          "bg-destructive border-transparent",
          Platform.select({ web: "[a&]:hover:bg-destructive/90" })
        ),
        outline: Platform.select({
          web: "[a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        }),
        secondary: cn(
          "bg-secondary border-transparent",
          Platform.select({ web: "[a&]:hover:bg-secondary/90" })
        ),
      },
    },
  }
);

const badgeTextVariants = cva("text-xs font-medium", {
  defaultVariants: {
    variant: "default",
  },
  variants: {
    variant: {
      default: "text-primary-foreground",
      destructive: "text-white",
      outline: "text-foreground",
      secondary: "text-secondary-foreground",
    },
  },
});

type BadgeProps = React.ComponentProps<typeof View> &
  React.RefAttributes<View> & {
    asChild?: boolean;
  } & VariantProps<typeof badgeVariants>;

const Badge = ({ className, variant, asChild, ...props }: BadgeProps) => {
  const Component = asChild ? Slot : View;
  const textClassName = useMemo(
    () => badgeTextVariants({ variant }),
    [variant]
  );

  return (
    <TextClassContext.Provider value={textClassName}>
      <Component
        className={cn(badgeVariants({ variant }), className)}
        {...props}
      />
    </TextClassContext.Provider>
  );
};

export { Badge, badgeTextVariants, badgeVariants };
export type { BadgeProps };
