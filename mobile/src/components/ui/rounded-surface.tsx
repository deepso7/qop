import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { View } from "react-native";

import { cn } from "@/lib/utils";

const roundedSurfaceVariants = cva("border-continuous", {
  defaultVariants: { variant: "panel" },
  variants: {
    variant: {
      panel: "bg-background-element rounded-panel gap-2 p-4",
      code: "bg-code-background gap-4 rounded-md p-4",
      field:
        "border-faint bg-input flex-row items-center gap-1 rounded-md border px-4",
      restore: "border-faint bg-input rounded-md border px-4 py-3",
      cell: "border-faint bg-input items-center justify-center rounded-md border py-2",
      primary:
        "bg-primary flex-row items-center justify-center gap-3 rounded-md px-5 py-3",
      quiet:
        "flex-row items-center justify-center gap-3 rounded-md px-5 py-2.5",
    },
    focused: { true: "border-ring border", false: "" },
    pressed: { true: "opacity-80", false: "" },
  },
});

type RoundedSurfaceProps = React.ComponentProps<typeof View> &
  VariantProps<typeof roundedSurfaceVariants>;

export const RoundedSurface = ({
  className,
  variant,
  focused,
  pressed,
  ...props
}: RoundedSurfaceProps) => (
  <View
    className={cn(
      roundedSurfaceVariants({ variant, focused, pressed }),
      className
    )}
    {...props}
  />
);
