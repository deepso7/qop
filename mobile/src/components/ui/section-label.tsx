import type { ComponentProps } from "react";

import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

export const SectionLabel = ({
  className,
  ...props
}: ComponentProps<typeof Text>) => (
  <Text
    className={cn("text-faint font-paper px-1 text-xs leading-4", className)}
    {...props}
  />
);
