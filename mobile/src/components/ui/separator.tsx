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
      "bg-border shrink-0",
      orientation === "horizontal" ? "h-hairline w-full" : "w-hairline h-full",
      className
    )}
    {...props}
  />
);

export { Separator };
