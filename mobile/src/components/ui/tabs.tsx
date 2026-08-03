import * as TabsPrimitiveModule from "@rn-primitives/tabs";
import { Platform } from "react-native";

import { TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";

const TabsPrimitive = { ...TabsPrimitiveModule };

const Tabs = ({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) => (
  <TabsPrimitive.Root
    className={cn("flex flex-col gap-2", className)}
    {...props}
  />
);

const TabsList = ({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) => (
  <TabsPrimitive.List
    className={cn(
      "bg-muted flex h-11 flex-row items-center justify-center rounded-lg p-1",
      Platform.select({ native: "mr-auto", web: "inline-flex w-fit" }),
      className
    )}
    {...props}
  />
);

const TabsTrigger = ({
  className,
  hitSlop,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) => {
  const { value } = TabsPrimitive.useRootContext();
  const textClassName = cn(
    "text-foreground dark:text-muted-foreground text-sm font-medium",
    value === props.value && "dark:text-foreground"
  );
  return (
    <TextClassContext.Provider value={textClassName}>
      <TabsPrimitive.Trigger
        className={cn(
          "flex h-9 flex-row items-center justify-center gap-1.5 rounded-md border border-transparent px-3 shadow-none shadow-black/5",
          Platform.select({
            web: "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring web:h-[calc(100%-1px)] inline-flex cursor-default whitespace-nowrap transition-[color,box-shadow] focus-visible:outline-1 focus-visible:ring-[3px] disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
          }),
          props.disabled && "opacity-50",
          props.value === value &&
            "bg-background dark:border-foreground/10 dark:bg-input/30",
          className
        )}
        hitSlop={hitSlop ?? 4}
        {...props}
      />
    </TextClassContext.Provider>
  );
};

const TabsContent = ({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) => (
  <TabsPrimitive.Content
    className={cn(Platform.select({ web: "flex-1 outline-none" }), className)}
    {...props}
  />
);

export { Tabs, TabsContent, TabsList, TabsTrigger };
