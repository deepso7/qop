import type { ComponentProps } from "react";

import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

export const SectionLabel = ({
  className,
  ...props
}: ComponentProps<typeof Text>) => (
  <Text
    className={cn(
      "text-muted-foreground px-1 font-mono text-xs font-semibold tracking-wider uppercase",
      className
    )}
    {...props}
  />
);
