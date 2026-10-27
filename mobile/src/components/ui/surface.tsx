import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { View } from "react-native";

import { cn } from "@/lib/utils";

// `tone` is the fill; `variant` the shape and inner spacing.
const surfaceVariants = cva("bg-background border-continuous", {
  defaultVariants: { tone: "default", variant: "plain" },
  variants: {
    tone: {
      default: "bg-background",
      element: "bg-background-element",
      selected: "bg-background-selected",
    },
    variant: {
      // A padded, rounded block with gapped children.
      card: "gap-4 rounded-xl p-4",
      // A tab or segment in a bar.
      chip: "rounded-md px-4",
      // A card with a 1px border.
      outline: "border-background-selected gap-4 rounded-xl border p-4",
      plain: "",
      // A floating bar of chips and actions.
      toolbar: "gap-2 rounded-2xl px-8 py-2",
    },
  },
});

type SurfaceProps = React.ComponentProps<typeof View> &
  VariantProps<typeof surfaceVariants>;

const Surface = ({ className, tone, variant, ...props }: SurfaceProps) => (
  <View
    className={cn(surfaceVariants({ tone, variant }), className)}
    {...props}
  />
);

export { Surface, surfaceVariants };

export type { SurfaceProps };
