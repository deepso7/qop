import { View } from "react-native";

import { Text, TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";

const Card = ({
  className,
  ...props
}: React.ComponentProps<typeof View> & React.RefAttributes<View>) => (
  <TextClassContext.Provider value="text-card-foreground">
    <View
      className={cn(
        "bg-card border-border flex flex-col gap-6 rounded-xl border py-6 shadow-sm shadow-black/5",
        className
      )}
      {...props}
    />
  </TextClassContext.Provider>
);

const CardHeader = ({
  className,
  ...props
}: React.ComponentProps<typeof View> & React.RefAttributes<View>) => (
  <View className={cn("flex flex-col gap-1.5 px-6", className)} {...props} />
);

const CardTitle = ({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof Text> & React.RefAttributes<typeof Text>) => (
  <Text
    ref={ref}
    accessibilityRole="header"
    className={cn("font-semibold leading-none", className)}
    {...props}
  />
);

const CardDescription = ({
  className,
  ...props
}: React.ComponentProps<typeof Text> & React.RefAttributes<typeof Text>) => (
  <Text className={cn("text-muted-foreground text-sm", className)} {...props} />
);

const CardContent = ({
  className,
  ...props
}: React.ComponentProps<typeof View> & React.RefAttributes<View>) => (
  <View className={cn("px-6", className)} {...props} />
);

const CardFooter = ({
  className,
  ...props
}: React.ComponentProps<typeof View> & React.RefAttributes<View>) => (
  <View
    className={cn("flex flex-row items-center px-6", className)}
    {...props}
  />
);

export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
};
