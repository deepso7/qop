import * as RadioGroupPrimitiveModule from "@rn-primitives/radio-group";
import { Platform, View } from "react-native";

import { cn } from "@/lib/utils";

const RadioGroupPrimitive = { ...RadioGroupPrimitiveModule };

const radioClasses =
  "border-faint dark:bg-input/30 aspect-square size-4 shrink-0 items-center justify-center rounded-full border";

const RadioGroup = ({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) => (
  <RadioGroupPrimitive.Root className={cn("gap-3", className)} {...props} />
);

const RadioGroupItem = ({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) => (
  <RadioGroupPrimitive.Item
    className={cn(
      "shrink-0 items-center justify-center",
      Platform.select({
        native: "size-11 android:size-12",
        web: cn(
          radioClasses,
          "focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-all outline-none focus-visible:ring-3 disabled:cursor-not-allowed"
        ),
      }),
      props.disabled && "opacity-50",
      className
    )}
    {...props}
  >
    <View
      accessible={false}
      className={Platform.OS === "web" ? "contents" : radioClasses}
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
    >
      <RadioGroupPrimitive.Indicator className="bg-primary size-2 rounded-full" />
    </View>
  </RadioGroupPrimitive.Item>
);

export { RadioGroup, RadioGroupItem };
