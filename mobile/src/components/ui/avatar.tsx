import * as AvatarPrimitiveModule from "@rn-primitives/avatar";

import { cn } from "@/lib/utils";

const AvatarPrimitive = { ...AvatarPrimitiveModule };

const Avatar = ({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root>) => (
  <AvatarPrimitive.Root
    className={cn(
      "relative flex size-8 shrink-0 overflow-hidden rounded-full",
      className
    )}
    {...props}
  />
);

const AvatarImage = ({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Image>) => (
  <AvatarPrimitive.Image
    className={cn("aspect-square size-full", className)}
    {...props}
  />
);

const AvatarFallback = ({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) => (
  <AvatarPrimitive.Fallback
    className={cn(
      "bg-muted flex size-full flex-row items-center justify-center rounded-full",
      className
    )}
    {...props}
  />
);

export { Avatar, AvatarFallback, AvatarImage };
