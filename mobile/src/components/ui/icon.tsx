import type { LucideIcon, LucideProps } from "lucide-react-native";
import * as React from "react";
import { withUniwind } from "uniwind";

import { TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";

type IconProps = LucideProps & {
  as: LucideIcon;
} & React.RefAttributes<LucideIcon>;

const IconImpl = ({ as: IconComponent, ...props }: IconProps) => (
  <IconComponent {...props} />
);

const StyledIcon = withUniwind(IconImpl, {
  color: {
    fromClassName: "className",
    styleProperty: "color",
  },
  fill: {
    fromClassName: "className",
    styleProperty: "fill",
  },
  size: {
    fromClassName: "className",
    styleProperty: "width",
  },
});

const Icon = ({ className, ...props }: IconProps) => {
  const textClass = React.useContext(TextClassContext);

  return (
    <StyledIcon
      {...props}
      className={cn("text-foreground size-5", textClass, className)}
    />
  );
};

export { Icon };
