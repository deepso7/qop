import * as ProgressPrimitiveModule from "@rn-primitives/progress";
import { Platform, View } from "react-native";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useDerivedValue,
  withSpring,
} from "react-native-reanimated";

import { cn } from "@/lib/utils";

const ProgressPrimitive = { ...ProgressPrimitiveModule };

interface IndicatorProps {
  value: number | undefined | null;
  className?: string;
}

const WebIndicator = ({ value, className }: IndicatorProps) => {
  if (Platform.OS !== "web") {
    return null;
  }

  return (
    <View
      className={cn(
        "bg-primary h-full w-full flex-1 transition-all",
        className
      )}
      style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
    >
      <ProgressPrimitive.Indicator className={cn("h-full w-full", className)} />
    </View>
  );
};

const NativeIndicator = ({ value, className }: IndicatorProps) => {
  const progress = useDerivedValue(() => value ?? 0);

  const indicator = useAnimatedStyle(
    () => ({
      width: withSpring(
        `${interpolate(progress.value, [0, 100], [1, 100], Extrapolation.CLAMP)}%`,
        { overshootClamping: true }
      ),
    }),
    [value]
  );

  if (Platform.OS === "web") {
    return null;
  }

  return (
    <ProgressPrimitive.Indicator asChild>
      <Animated.View
        style={indicator}
        className={cn("bg-foreground h-full", className)}
      />
    </ProgressPrimitive.Indicator>
  );
};

const NullIndicator = (_props: IndicatorProps) => null;

const Indicator = Platform.select({
  default: NullIndicator,
  native: NativeIndicator,
  web: WebIndicator,
});

const Progress = ({
  className,
  value,
  indicatorClassName,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & {
  indicatorClassName?: string;
}) => (
  <ProgressPrimitive.Root
    className={cn(
      "bg-primary/20 relative h-2 w-full overflow-hidden rounded-full",
      className
    )}
    {...props}
  >
    <Indicator value={value} className={indicatorClassName} />
  </ProgressPrimitive.Root>
);

export { Progress };
