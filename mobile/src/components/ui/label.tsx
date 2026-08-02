import { Text } from "react-native";

import { cn } from "@/lib/utils";

type LabelProps = React.ComponentProps<typeof Text> & {
  disabled?: boolean;
};

const Label = ({ className, disabled, ...props }: LabelProps) => (
  <Text
    className={cn(
      "text-foreground text-sm font-medium",
      disabled && "opacity-50",
      className
    )}
    {...props}
  />
);

export { Label };
