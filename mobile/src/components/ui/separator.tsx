import { View } from "react-native";

import { cn } from "@/lib/utils";

type SeparatorProps = React.ComponentProps<typeof View> & {
  decorative?: boolean;
  orientation?: "horizontal" | "vertical";
};

const Separator = ({
  className,
  decorative = true,
  orientation = "horizontal",
  ...props
}: SeparatorProps) => (
  <View
    accessibilityElementsHidden={decorative}
    accessibilityRole={decorative ? "none" : undefined}
    className={cn(
      "shrink-0 bg-border",
      orientation === "horizontal" ? "h-hairline w-full" : "h-full w-hairline",
      className
    )}
    {...props}
  />
);

export { Separator };
