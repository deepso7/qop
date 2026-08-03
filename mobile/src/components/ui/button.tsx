import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { useMemo } from "react";
import { Platform, Pressable } from "react-native";
import type { PressableStateCallbackType } from "react-native";
import {
  createAnimatedComponent,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import { TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";

const AnimatedPressable = createAnimatedComponent(Pressable);

const buttonVariants = cva(
  cn(
    "group shrink-0 flex-row items-center justify-center gap-2 rounded-md shadow-none",
    Platform.select({
      web: "focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive whitespace-nowrap outline-none transition-all focus-visible:ring-[3px] disabled:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
    })
  ),
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: cn(
          "h-11 px-4 py-2",
          Platform.select({ web: "has-[>svg]:px-3" })
        ),
        icon: "size-11",
        lg: cn(
          "h-12 rounded-md px-6",
          Platform.select({ web: "has-[>svg]:px-4" })
        ),
        sm: cn(
          "h-8 gap-1 rounded-md px-3",
          Platform.select({ web: "has-[>svg]:px-2.5" })
        ),
      },
      variant: {
        default: cn(
          "bg-primary active:bg-primary/90",
          Platform.select({ web: "hover:bg-primary/90" })
        ),
        destructive: cn(
          "bg-destructive active:bg-destructive/90 dark:bg-destructive/60",
          Platform.select({
            web: "hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
          })
        ),
        ghost: cn(
          "active:bg-accent dark:active:bg-accent/50",
          Platform.select({ web: "hover:bg-accent dark:hover:bg-accent/50" })
        ),
        link: "",
        outline: cn(
          "border-border bg-background active:bg-accent dark:bg-input/30 dark:border-input dark:active:bg-input/50 border",
          Platform.select({
            web: "hover:bg-accent dark:hover:bg-input/50",
          })
        ),
        secondary: cn(
          "bg-secondary active:bg-secondary/80",
          Platform.select({ web: "hover:bg-secondary/80" })
        ),
      },
    },
  }
);

const buttonTextVariants = cva(
  cn(
    "text-foreground text-sm font-medium",
    Platform.select({ web: "pointer-events-none transition-colors" })
  ),
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "",
        icon: "",
        lg: "text-base",
        sm: "text-xs",
      },
      variant: {
        default: "text-primary-foreground",
        destructive: "text-white",
        ghost: "group-active:text-accent-foreground",
        link: cn(
          "text-primary group-active:underline",
          Platform.select({
            web: "underline-offset-4 hover:underline group-hover:underline",
          })
        ),
        outline: cn(
          "group-active:text-accent-foreground",
          Platform.select({ web: "group-hover:text-accent-foreground" })
        ),
        secondary: "text-secondary-foreground",
      },
    },
  }
);

type ButtonProps = React.ComponentProps<typeof Pressable> &
  React.RefAttributes<typeof Pressable> &
  VariantProps<typeof buttonVariants>;

const getDefaultHitSlop = (size: ButtonProps["size"]) =>
  size === "sm" ? 6 : undefined;

const Button = ({
  className,
  hitSlop,
  onPressIn,
  onPressOut,
  style,
  variant,
  size,
  ...props
}: ButtonProps) => {
  const defaultHitSlop = getDefaultHitSlop(size);
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(1);
  const textClassName = useMemo(
    () => buttonTextVariants({ size, variant }),
    [size, variant]
  );
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.get() }],
  }));

  const handlePressIn: NonNullable<ButtonProps["onPressIn"]> = (event) => {
    if (!reduceMotion) {
      scale.set(withTiming(0.98, { duration: 100 }));
    }
    onPressIn?.(event);
  };

  const handlePressOut: NonNullable<ButtonProps["onPressOut"]> = (event) => {
    if (!reduceMotion) {
      scale.set(withSpring(1, { dampingRatio: 1, duration: 180 }));
    }
    onPressOut?.(event);
  };

  return (
    <TextClassContext.Provider value={textClassName}>
      <AnimatedPressable
        className={cn(
          props.disabled && "opacity-50",
          buttonVariants({ size, variant }),
          className
        )}
        accessibilityRole="button"
        hitSlop={hitSlop ?? defaultHitSlop}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={(state: PressableStateCallbackType) => [
          { borderCurve: "continuous" },
          animatedStyle,
          typeof style === "function" ? style(state) : style,
        ]}
        {...props}
      />
    </TextClassContext.Provider>
  );
};

export { Button, buttonTextVariants, buttonVariants };
export type { ButtonProps };
