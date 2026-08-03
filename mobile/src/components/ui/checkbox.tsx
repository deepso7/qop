import * as CheckboxPrimitiveModule from "@rn-primitives/checkbox";
import { Platform, Text } from "react-native";
import Animated, { Keyframe, ReduceMotion } from "react-native-reanimated";

import { cn } from "@/lib/utils";

const CheckboxPrimitive = { ...CheckboxPrimitiveModule };

const DEFAULT_HIT_SLOP = 14;
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
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root> & {
  checkedClassName?: string;
  indicatorClassName?: string;
  iconClassName?: string;
}) => (
  <CheckboxPrimitive.Root
    className={cn(
      "border-input dark:bg-input/30 size-4 shrink-0 rounded border",
      Platform.select({
        native: "overflow-hidden",
        web: "focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive peer cursor-default outline-none transition-shadow focus-visible:ring-[3px] disabled:cursor-not-allowed",
      }),
      props.checked && cn("border-foreground", checkedClassName),
      props.disabled && "opacity-50",
      className
    )}
    hitSlop={DEFAULT_HIT_SLOP}
    {...props}
  >
    <CheckboxPrimitive.Indicator asChild>
      <Animated.View
        className={cn(
          "bg-foreground h-full w-full items-center justify-center",
          indicatorClassName
        )}
        entering={indicatorEnter}
        exiting={indicatorExit}
      >
        <Text
          className={cn(
            "text-background w-full text-center text-[10px] font-bold leading-3",
            iconClassName
          )}
        >
          ✓
        </Text>
      </Animated.View>
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
);

export { Checkbox };
