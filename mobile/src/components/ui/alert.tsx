import type { LucideIcon } from "lucide-react-native";
import * as React from "react";
import { View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { Text, TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";

const Alert = ({
  className,
  variant,
  children,
  icon,
  iconClassName,
  ...props
}: React.ComponentProps<typeof View> &
  React.RefAttributes<View> & {
    icon: LucideIcon;
    variant?: "default" | "destructive";
    iconClassName?: string;
  }) => {
  const textClassName = cn(
    "text-foreground text-sm",
    variant === "destructive" && "text-destructive",
    className
  );

  return (
    <TextClassContext.Provider value={textClassName}>
      <View
        role="alert"
        className={cn(
          "bg-card border-border relative w-full rounded-lg border px-4 pt-3.5 pb-2",
          className
        )}
        {...props}
      >
        <View className="absolute top-3 left-3.5">
          <Icon
            as={icon}
            className={cn(
              "size-4",
              variant === "destructive" && "text-destructive",
              iconClassName
            )}
          />
        </View>
        {children}
      </View>
    </TextClassContext.Provider>
  );
};

const AlertTitle = ({
  className,
  ...props
}: React.ComponentProps<typeof Text>) => (
  <Text
    className={cn(
      "mb-1 ml-0.5 min-h-4 pl-6 leading-none font-medium tracking-tight",
      className
    )}
    {...props}
  />
);

const AlertDescription = ({
  className,
  ...props
}: React.ComponentProps<typeof Text>) => {
  const textClass = React.useContext(TextClassContext);
  return (
    <Text
      className={cn(
        "text-muted-foreground ml-0.5 pb-1.5 pl-6 text-sm leading-relaxed",
        textClass?.includes("text-destructive") && "text-destructive/90",
        className
      )}
      {...props}
    />
  );
};

export { Alert, AlertDescription, AlertTitle };
