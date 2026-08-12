import * as AlertDialogPrimitiveModule from "@rn-primitives/alert-dialog";
import type { VariantProps } from "class-variance-authority";
import * as React from "react";
import { Platform, View } from "react-native";
import type { ViewProps } from "react-native";
import { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { FullWindowOverlay as RNFullWindowOverlay } from "react-native-screens";

import { buttonTextVariants, buttonVariants } from "@/components/ui/button";
import { NativeOnlyAnimatedView } from "@/components/ui/native-only-animated-view";
import { TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";

const AlertDialogPrimitive = { ...AlertDialogPrimitiveModule };

const AlertDialog = AlertDialogPrimitive.Root;

const AlertDialogTrigger = AlertDialogPrimitive.Trigger;

const AlertDialogPortal = AlertDialogPrimitive.Portal;

const FullWindowOverlay =
  Platform.OS === "ios" ? RNFullWindowOverlay : React.Fragment;

const AlertDialogOverlay = ({
  className,
  children,
  ...props
}: Omit<
  React.ComponentProps<typeof AlertDialogPrimitive.Overlay>,
  "asChild"
> & {
  children?: React.ReactNode;
}) => (
  <FullWindowOverlay>
    <AlertDialogPrimitive.Overlay
      className={cn(
        "absolute bottom-0 left-0 right-0 top-0 z-50 flex items-center justify-center bg-black/50 p-2",
        Platform.select({
          web: "animate-in fade-in-0 fixed",
        }),
        className
      )}
      {...props}
      asChild={Platform.OS !== "web"}
    >
      <NativeOnlyAnimatedView
        entering={FadeIn.duration(200)
          .delay(50)
          .reduceMotion(ReduceMotion.System)}
        exiting={FadeOut.duration(150).reduceMotion(ReduceMotion.System)}
        as="Pressable"
      >
        {children}
      </NativeOnlyAnimatedView>
    </AlertDialogPrimitive.Overlay>
  </FullWindowOverlay>
);

const AlertDialogContent = ({
  className,
  portalHost,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content> & {
  portalHost?: string;
}) => (
  <AlertDialogPortal hostName={portalHost}>
    <AlertDialogOverlay>
      <AlertDialogPrimitive.Content
        className={cn(
          "bg-background border-border z-50 flex flex-col gap-4 rounded-lg border p-6 shadow-lg shadow-black/5 sm:max-w-lg",
          Platform.select({
            web: "animate-in fade-in-0 zoom-in-95 web:max-w-[calc(100%-2rem)] duration-200",
          }),
          className
        )}
        {...props}
      />
    </AlertDialogOverlay>
  </AlertDialogPortal>
);

const AlertDialogHeader = ({ className, ...props }: ViewProps) => (
  <TextClassContext.Provider value="text-center sm:text-left">
    <View className={cn("flex flex-col gap-2", className)} {...props} />
  </TextClassContext.Provider>
);

const AlertDialogFooter = ({ className, ...props }: ViewProps) => (
  <View
    className={cn(
      "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
      className
    )}
    {...props}
  />
);

const AlertDialogTitle = ({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) => (
  <AlertDialogPrimitive.Title
    className={cn("text-foreground text-lg font-semibold", className)}
    {...props}
  />
);

const AlertDialogDescription = ({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) => (
  <AlertDialogPrimitive.Description
    className={cn("text-muted-foreground text-sm", className)}
    {...props}
  />
);

type AlertDialogActionProps = React.ComponentProps<
  typeof AlertDialogPrimitive.Action
> &
  Pick<VariantProps<typeof buttonVariants>, "variant">;

const AlertDialogAction = ({
  className,
  variant,
  ...props
}: AlertDialogActionProps) => {
  const textClassName = buttonTextVariants({ className, variant });

  return (
    <TextClassContext.Provider value={textClassName}>
      <AlertDialogPrimitive.Action
        className={cn(buttonVariants({ variant }), className)}
        {...props}
      />
    </TextClassContext.Provider>
  );
};

const AlertDialogCancel = ({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>) => {
  const textClassName = buttonTextVariants({ className, variant: "outline" });

  return (
    <TextClassContext.Provider value={textClassName}>
      <AlertDialogPrimitive.Cancel
        className={cn(buttonVariants({ variant: "outline" }), className)}
        {...props}
      />
    </TextClassContext.Provider>
  );
};

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
