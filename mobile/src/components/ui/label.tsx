import { Text } from "react-native";

import { cn } from "@/lib/utils";

type LabelProps = React.ComponentProps<typeof Text> & {
  disabled?: boolean;
};

const Label = ({ className, disabled, ...props }: LabelProps) => (
  <Text
    className={cn(
      "text-foreground font-sans-medium font-sans text-sm",
      disabled && "opacity-50",
      className
    )}
    {...props}
  />
);

export { Label };
