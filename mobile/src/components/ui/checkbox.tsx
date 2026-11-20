import * as CheckboxPrimitiveModule from "@rn-primitives/checkbox";
import { Check } from "lucide-react-native";
import { Platform, View } from "react-native";
import Animated, { Keyframe, ReduceMotion } from "react-native-reanimated";

import { Icon } from "@/components/ui/icon";
import { selectionHaptic } from "@/lib/haptics";
import { cn } from "@/lib/utils";

const CheckboxPrimitive = { ...CheckboxPrimitiveModule };

const checkboxClasses =
  "border-faint dark:bg-input/30 size-4 shrink-0 rounded border";

const indicatorEnter = new Keyframe({
  0: { opacity: 0, transform: [{ scale: 0.92 }] },
  100: { opacity: 1, transform: [{ scale: 1 }] },
})
  .duration(140)
  .reduceMotion(ReduceMotion.System);

const indicatorExit = new Keyframe({
  0: { opacity: 1, transform: [{ scale: 1 }] },
  100: { opacity: 0, transform: [{ scale: 0.92 }] },
})
  .duration(100)
  .reduceMotion(ReduceMotion.System);

const Checkbox = ({
  className,
  checkedClassName,
  indicatorClassName,
  iconClassName,
  onCheckedChange,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root> & {
  checkedClassName?: string;
  indicatorClassName?: string;
  iconClassName?: string;
}) => (
  <CheckboxPrimitive.Root
    className={cn(
      "shrink-0 items-center justify-center",
      Platform.select({
        native: "size-11 android:size-12",
        web: cn(
          checkboxClasses,
          "focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive peer cursor-default transition-shadow outline-none focus-visible:ring-3 disabled:cursor-not-allowed",
          props.checked && cn("border-primary", checkedClassName)
        ),
      }),
      props.disabled && "opacity-50",
      className
    )}
    onCheckedChange={(checked) => {
      void selectionHaptic();
      onCheckedChange?.(checked);
    }}
    {...props}
  >
    <View
      accessible={false}
      className={Platform.select({
        native: cn(
          checkboxClasses,
          "overflow-hidden",
          props.checked && cn("border-primary", checkedClassName)
        ),
        web: "contents",
      })}
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
    >
      <CheckboxPrimitive.Indicator asChild>
        <Animated.View
          className={cn(
            "bg-primary h-full w-full items-center justify-center",
            indicatorClassName
          )}
          entering={indicatorEnter}
          exiting={indicatorExit}
        >
          <Icon
            as={Check}
            className={cn("text-primary-foreground size-3", iconClassName)}
            strokeWidth={3}
          />
        </Animated.View>
      </CheckboxPrimitive.Indicator>
    </View>
  </CheckboxPrimitive.Root>
);

export { Checkbox };
