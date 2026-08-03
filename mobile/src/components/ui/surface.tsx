import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { View } from "react-native";

import { cn } from "@/lib/utils";

const surfaceVariants = cva("bg-background", {
  defaultVariants: { tone: "default" },
  variants: {
    tone: {
      default: "bg-background",
      element: "bg-background-element",
      selected: "bg-background-selected",
    },
  },
});

type SurfaceProps = React.ComponentProps<typeof View> &
  VariantProps<typeof surfaceVariants>;

const Surface = ({ className, style, tone, ...props }: SurfaceProps) => (
  <View
    className={cn(surfaceVariants({ tone }), className)}
    style={[{ borderCurve: "continuous" }, style]}
    {...props}
  />
);

export { Surface, surfaceVariants };
export type { SurfaceProps };
