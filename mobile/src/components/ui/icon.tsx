import type { VariantProps } from "class-variance-authority";
import type { LucideIcon, LucideProps } from "lucide-react-native";
import * as React from "react";
import { withUniwind } from "uniwind";

import { TextClassContext, textToneVariants } from "@/components/ui/text";
import { cn } from "@/lib/utils";

type IconProps = LucideProps & {
  as: LucideIcon;
} & React.RefAttributes<LucideIcon> &
  VariantProps<typeof textToneVariants>;

const IconImpl = ({
  as: IconComponent,
  fill,
  ...props
}: Omit<IconProps, "tone">) => (
  <IconComponent {...props} fill={fill ?? "none"} />
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

// Colour comes from `tone` (the same scale as Text's) or a parent
// TextClassContext; size from a size-* class.
const Icon = ({ className, tone, ...props }: IconProps) => {
  const textClass = React.useContext(TextClassContext);

  return (
    <StyledIcon
      {...props}
      className={cn(
        "text-foreground size-5",
        textClass,
        textToneVariants({ tone }),
        className
      )}
    />
  );
};

export { Icon };
