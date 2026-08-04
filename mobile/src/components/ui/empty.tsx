import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import * as React from "react";
import { View } from "react-native";

import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

const emptyVariants = cva(
  "items-center justify-center gap-6 rounded-[22px] px-6 py-10",
  {
    defaultVariants: { variant: "default" },
    variants: {
      variant: {
        default: "",
        outline: "border-border border border-dashed",
      },
    },
  }
);

type EmptyProps = React.ComponentProps<typeof View> &
  VariantProps<typeof emptyVariants>;

const Empty = ({ className, variant, ...props }: EmptyProps) => (
  <View className={cn(emptyVariants({ variant }), className)} {...props} />
);

const EmptyHeader = ({
  className,
  ...props
}: React.ComponentProps<typeof View>) => (
  <View className={cn("max-w-sm items-center gap-2", className)} {...props} />
);

const emptyMediaVariants = cva("items-center justify-center", {
  defaultVariants: { variant: "default" },
  variants: {
    variant: {
      default: "",
      icon: "bg-background-element mb-2 size-14 rounded-[18px]",
    },
  },
});

type EmptyMediaProps = React.ComponentProps<typeof View> &
  VariantProps<typeof emptyMediaVariants>;

const EmptyMedia = ({ className, variant, ...props }: EmptyMediaProps) => (
  <View
    className={cn(emptyMediaVariants({ variant }), className)}
    style={{ borderCurve: "continuous" }}
    {...props}
  />
);

const EmptyTitle = ({
  className,
  ...props
}: React.ComponentProps<typeof Text>) => (
  <Text
    className={cn("text-center text-lg", className)}
    variant="h4"
    {...props}
  />
);

const EmptyDescription = ({
  className,
  ...props
}: React.ComponentProps<typeof Text>) => (
  <Text
    className={cn(
      "text-foreground-secondary text-center text-sm leading-5",
      className
    )}
    {...props}
  />
);

const EmptyContent = ({
  className,
  ...props
}: React.ComponentProps<typeof View>) => (
  <View className={cn("items-center gap-3", className)} {...props} />
);

export {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
};
export type { EmptyMediaProps, EmptyProps };
