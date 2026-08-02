import * as ContextMenuPrimitiveModule from "@rn-primitives/context-menu";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
} from "lucide-react-native";
import * as React from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import { FadeIn, ReduceMotion } from "react-native-reanimated";
import { FullWindowOverlay as RNFullWindowOverlay } from "react-native-screens";

import { Icon } from "@/components/ui/icon";
import { NativeOnlyAnimatedView } from "@/components/ui/native-only-animated-view";
import { TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";

const ContextMenuPrimitive = { ...ContextMenuPrimitiveModule };

const ContextMenu = ContextMenuPrimitive.Root;
const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
const ContextMenuGroup = ContextMenuPrimitive.Group;
const ContextMenuSub = ContextMenuPrimitive.Sub;
const ContextMenuRadioGroup = ContextMenuPrimitive.RadioGroup;

const getSubmenuIcon = (open: boolean) => {
  if (Platform.OS === "web") {
    return ChevronRight;
  }
  return open ? ChevronUp : ChevronDown;
};

const ContextMenuSubTrigger = ({
  className,
  inset,
  children,
  iconClassName,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & {
  children?: React.ReactNode;
  iconClassName?: string;
  inset?: boolean;
}) => {
  const { open } = ContextMenuPrimitive.useSubContext();
  const icon = getSubmenuIcon(open);
  const textClassName = cn(
    "text-sm select-none group-active:text-accent-foreground",
    open && "text-accent-foreground"
  );
  return (
    <TextClassContext.Provider value={textClassName}>
      <ContextMenuPrimitive.SubTrigger
        className={cn(
          "active:bg-accent group flex flex-row items-center justify-between rounded-sm px-2 py-2 sm:py-1.5",
          Platform.select({
            web: "focus:bg-accent focus:text-accent-foreground cursor-default outline-none [&_svg]:pointer-events-none",
          }),
          className,
          open && cn("bg-accent", Platform.select({ native: "mb-1" })),
          inset && "pl-8"
        )}
        {...props}
      >
        {children}
        <Icon
          as={icon}
          className={cn("text-foreground size-4 shrink-0", iconClassName)}
        />
      </ContextMenuPrimitive.SubTrigger>
    </TextClassContext.Provider>
  );
};

const ContextMenuSubContent = ({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) => (
  <NativeOnlyAnimatedView entering={FadeIn.reduceMotion(ReduceMotion.System)}>
    <ContextMenuPrimitive.SubContent
      className={cn(
        "bg-popover border-border overflow-hidden rounded-md border p-1 shadow-lg shadow-black/5",
        Platform.select({
          web: "animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 fade-in-0 data-[state=closed]:zoom-out-95 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-(--radix-context-menu-content-transform-origin) z-50 min-w-[8rem]",
        }),
        className
      )}
      {...props}
    />
  </NativeOnlyAnimatedView>
);

const FullWindowOverlay =
  Platform.OS === "ios" ? RNFullWindowOverlay : React.Fragment;

const ContextMenuContent = ({
  className,
  overlayClassName,
  overlayStyle,
  portalHost,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content> & {
  overlayStyle?: StyleProp<ViewStyle>;
  overlayClassName?: string;
  portalHost?: string;
}) => (
  <ContextMenuPrimitive.Portal hostName={portalHost}>
    <FullWindowOverlay>
      <ContextMenuPrimitive.Overlay
        style={
          StyleSheet.flatten([
            StyleSheet.absoluteFill,
            overlayStyle,
          ]) as typeof StyleSheet.absoluteFill
        }
        className={overlayClassName}
        asChild={Platform.OS !== "web"}
      >
        <NativeOnlyAnimatedView
          entering={FadeIn.reduceMotion(ReduceMotion.System)}
          as="Pressable"
        >
          <TextClassContext.Provider value="text-popover-foreground">
            <ContextMenuPrimitive.Content
              className={cn(
                "bg-popover border-border min-w-[8rem] overflow-hidden rounded-md border p-1 shadow-lg shadow-black/5",
                Platform.select({
                  web: cn(
                    "animate-in fade-in-0 zoom-in-95 max-h-(--radix-context-menu-content-available-height) origin-(--radix-context-menu-content-transform-origin) z-50 cursor-default",
                    props.side === "bottom" && "slide-in-from-top-2",
                    props.side === "top" && "slide-in-from-bottom-2"
                  ),
                }),
                className
              )}
              {...props}
            />
          </TextClassContext.Provider>
        </NativeOnlyAnimatedView>
      </ContextMenuPrimitive.Overlay>
    </FullWindowOverlay>
  </ContextMenuPrimitive.Portal>
);

const ContextMenuItem = ({
  className,
  inset,
  variant,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  className?: string;
  inset?: boolean;
  variant?: "default" | "destructive";
}) => {
  const textClassName = cn(
    "select-none text-sm text-popover-foreground group-active:text-popover-foreground",
    variant === "destructive" &&
      "text-destructive group-active:text-destructive"
  );

  return (
    <TextClassContext.Provider value={textClassName}>
      <ContextMenuPrimitive.Item
        className={cn(
          "active:bg-accent group relative flex flex-row items-center gap-2 rounded-sm px-2 py-2 sm:py-1.5",
          Platform.select({
            web: cn(
              "focus:bg-accent focus:text-accent-foreground cursor-default outline-none data-[disabled]:pointer-events-none",
              variant === "destructive" &&
                "focus:bg-destructive/10 dark:focus:bg-destructive/20"
            ),
          }),
          variant === "destructive" &&
            "active:bg-destructive/10 dark:active:bg-destructive/20",
          props.disabled && "opacity-50",
          inset && "pl-8",
          className
        )}
        {...props}
      />
    </TextClassContext.Provider>
  );
};

const ContextMenuCheckboxItem = ({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.CheckboxItem> & {
  children?: React.ReactNode;
}) => (
  <TextClassContext.Provider value="text-sm text-popover-foreground select-none group-active:text-accent-foreground">
    <ContextMenuPrimitive.CheckboxItem
      className={cn(
        "active:bg-accent group relative flex flex-row items-center gap-2 rounded-sm py-2 pl-8 pr-2 sm:py-1.5",
        Platform.select({
          web: "focus:bg-accent focus:text-accent-foreground cursor-default outline-none data-[disabled]:pointer-events-none",
        }),
        props.disabled && "opacity-50",
        className
      )}
      {...props}
    >
      <View className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <ContextMenuPrimitive.ItemIndicator>
          <Icon
            as={Check}
            className={cn(
              "text-foreground size-4",
              Platform.select({ web: "pointer-events-none" })
            )}
          />
        </ContextMenuPrimitive.ItemIndicator>
      </View>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  </TextClassContext.Provider>
);

const ContextMenuRadioItem = ({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioItem> & {
  children?: React.ReactNode;
}) => (
  <TextClassContext.Provider value="text-sm text-popover-foreground select-none group-active:text-accent-foreground">
    <ContextMenuPrimitive.RadioItem
      className={cn(
        "active:bg-accent group relative flex flex-row items-center gap-2 rounded-sm py-2 pl-8 pr-2 sm:py-1.5",
        Platform.select({
          web: "focus:bg-accent focus:text-accent-foreground cursor-default outline-none data-[disabled]:pointer-events-none",
        }),
        props.disabled && "opacity-50",
        className
      )}
      {...props}
    >
      <View className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <ContextMenuPrimitive.ItemIndicator>
          <View className="bg-foreground h-2 w-2 rounded-full" />
        </ContextMenuPrimitive.ItemIndicator>
      </View>
      {children}
    </ContextMenuPrimitive.RadioItem>
  </TextClassContext.Provider>
);

const ContextMenuLabel = ({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label> & {
  className?: string;
  inset?: boolean;
}) => (
  <ContextMenuPrimitive.Label
    className={cn(
      "text-foreground px-2 py-2 text-sm font-medium sm:py-1.5",
      inset && "pl-8",
      className
    )}
    {...props}
  />
);

const ContextMenuSeparator = ({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) => (
  <ContextMenuPrimitive.Separator
    className={cn("bg-border -mx-1 my-1 h-px", className)}
    {...props}
  />
);

const ContextMenuShortcut = ({
  className,
  ...props
}: React.ComponentProps<typeof Text>) => (
  <Text
    className={cn(
      "text-muted-foreground ml-auto text-xs tracking-widest",
      className
    )}
    {...props}
  />
);

export {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
};
