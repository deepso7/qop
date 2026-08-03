import * as MenubarPrimitiveModule from "@rn-primitives/menubar";
import { Portal } from "@rn-primitives/portal";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
} from "lucide-react-native";
import * as React from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import { FadeIn, ReduceMotion } from "react-native-reanimated";
import { FullWindowOverlay as RNFullWindowOverlay } from "react-native-screens";

import { Icon } from "@/components/ui/icon";
import { NativeOnlyAnimatedView } from "@/components/ui/native-only-animated-view";
import { TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";

const MenubarPrimitive = { ...MenubarPrimitiveModule };

const MenubarMenu = MenubarPrimitive.Menu;

const MenubarGroup = MenubarPrimitive.Group;

const MenubarPortal = MenubarPrimitive.Portal;

const MenubarSub = MenubarPrimitive.Sub;

const MenubarRadioGroup = MenubarPrimitive.RadioGroup;

const getSubmenuIcon = (open: boolean) => {
  if (Platform.OS === "web") {
    return ChevronRight;
  }
  return open ? ChevronUp : ChevronDown;
};

const FullWindowOverlay =
  Platform.OS === "ios" ? RNFullWindowOverlay : React.Fragment;

const Menubar = ({
  className,
  value: valueProp,
  onValueChange: onValueChangeProp,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.Root>) => {
  const id = React.useId();
  const [value, setValue] = React.useState<string | undefined>();

  const closeMenu = () => {
    if (onValueChangeProp) {
      onValueChangeProp("");
      return;
    }
    setValue(undefined);
  };

  return (
    <>
      {Platform.OS !== "web" && (value || valueProp) ? (
        <Portal name={`menubar-overlay-${id}`}>
          <Pressable onPress={closeMenu} style={StyleSheet.absoluteFill} />
        </Portal>
      ) : null}
      <MenubarPrimitive.Root
        className={cn(
          "bg-background border-border flex h-11 flex-row items-center gap-1 rounded-md border p-1 shadow-sm shadow-black/5",
          className
        )}
        value={value ?? valueProp}
        onValueChange={onValueChangeProp ?? setValue}
        {...props}
      />
    </>
  );
};

const MenubarTrigger = ({
  className,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.Trigger>) => {
  const { value } = MenubarPrimitive.useRootContext();
  const { value: itemValue } = MenubarPrimitive.useMenuContext();
  const textClassName = cn(
    "text-sm font-medium select-none group-active:text-accent-foreground",
    value === itemValue && "text-accent-foreground"
  );

  return (
    <TextClassContext.Provider value={textClassName}>
      <MenubarPrimitive.Trigger
        className={cn(
          "group flex min-h-9 items-center rounded-md px-2 py-1.5",
          Platform.select({
            web: "focus:bg-accent focus:text-accent-foreground cursor-default outline-none",
          }),
          value === itemValue && "bg-accent",
          className
        )}
        {...props}
      />
    </TextClassContext.Provider>
  );
};

const MenubarSubTrigger = ({
  className,
  inset,
  children,
  iconClassName,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.SubTrigger> & {
  children?: React.ReactNode;
  iconClassName?: string;
  inset?: boolean;
}) => {
  const { open } = MenubarPrimitive.useSubContext();
  const icon = getSubmenuIcon(open);
  const textClassName = cn(
    "text-sm select-none group-active:text-accent-foreground",
    open && "text-accent-foreground"
  );
  return (
    <TextClassContext.Provider value={textClassName}>
      <MenubarPrimitive.SubTrigger
        className={cn(
          "active:bg-accent group flex min-h-11 flex-row items-center justify-between rounded-sm px-2 py-2 web:min-h-0 web:py-1.5",
          Platform.select({
            web: "focus:bg-accent focus:text-accent-foreground cursor-default outline-none [&_svg]:pointer-events-none",
          }),
          className,
          open && "bg-accent",
          inset && "pl-8"
        )}
        {...props}
      >
        {children}
        <Icon
          as={icon}
          className={cn("text-foreground size-4 shrink-0", iconClassName)}
        />
      </MenubarPrimitive.SubTrigger>
    </TextClassContext.Provider>
  );
};

const MenubarSubContent = ({
  className,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.SubContent>) => (
  <NativeOnlyAnimatedView entering={FadeIn.reduceMotion(ReduceMotion.System)}>
    <MenubarPrimitive.SubContent
      className={cn(
        "bg-popover border-border overflow-hidden rounded-md border p-1 shadow-lg shadow-black/5",
        Platform.select({
          web: "animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 fade-in-0 data-[state=closed]:zoom-out-95 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-(--radix-context-menu-content-transform-origin) z-50 min-w-32",
        }),
        className
      )}
      {...props}
    />
  </NativeOnlyAnimatedView>
);

const MenubarContent = ({
  className,
  overlayClassName: _overlayClassName,
  overlayStyle: _overlayStyle,
  portalHost,
  align = "start",
  alignOffset = -4,
  sideOffset = 8,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.Content> & {
  overlayStyle?: StyleProp<ViewStyle>;
  overlayClassName?: string;
  portalHost?: string;
}) => (
  <MenubarPrimitive.Portal hostName={portalHost}>
    <FullWindowOverlay>
      <NativeOnlyAnimatedView
        as="Pressable"
        accessible={false}
        entering={FadeIn.reduceMotion(ReduceMotion.System)}
        style={StyleSheet.absoluteFill}
        pointerEvents="box-none"
      >
        <TextClassContext.Provider value="text-popover-foreground">
          <MenubarPrimitive.Content
            className={cn(
              "bg-popover border-border min-w-48 overflow-hidden rounded-md border p-1 shadow-lg shadow-black/5",
              Platform.select({
                web: cn(
                  "animate-in fade-in-0 zoom-in-95 max-h-(--radix-context-menu-content-available-height) origin-(--radix-context-menu-content-transform-origin) z-50 cursor-default",
                  props.side === "bottom" && "slide-in-from-top-2",
                  props.side === "top" && "slide-in-from-bottom-2"
                ),
              }),
              className
            )}
            align={align}
            alignOffset={alignOffset}
            sideOffset={sideOffset}
            {...props}
          />
        </TextClassContext.Provider>
      </NativeOnlyAnimatedView>
    </FullWindowOverlay>
  </MenubarPrimitive.Portal>
);

const MenubarItem = ({
  className,
  inset,
  variant,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.Item> & {
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
      <MenubarPrimitive.Item
        className={cn(
          "active:bg-accent group relative flex min-h-11 flex-row items-center gap-2 rounded-sm px-2 py-2 web:min-h-0 web:py-1.5",
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

const MenubarCheckboxItem = ({
  className,
  children,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.CheckboxItem> & {
  children?: React.ReactNode;
}) => (
  <TextClassContext.Provider value="text-sm text-popover-foreground select-none group-active:text-accent-foreground">
    <MenubarPrimitive.CheckboxItem
      className={cn(
        "active:bg-accent group relative flex min-h-11 flex-row items-center gap-2 rounded-sm py-2 pl-8 pr-2 web:min-h-0 web:py-1.5",
        Platform.select({
          web: "focus:bg-accent focus:text-accent-foreground cursor-default outline-none data-[disabled]:pointer-events-none",
        }),
        props.disabled && "opacity-50",
        className
      )}
      {...props}
    >
      <View className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <MenubarPrimitive.ItemIndicator>
          <Icon
            as={Check}
            className={cn(
              "text-foreground size-4",
              Platform.select({ web: "pointer-events-none" })
            )}
          />
        </MenubarPrimitive.ItemIndicator>
      </View>
      {children}
    </MenubarPrimitive.CheckboxItem>
  </TextClassContext.Provider>
);

const MenubarRadioItem = ({
  className,
  children,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.RadioItem> & {
  children?: React.ReactNode;
}) => (
  <TextClassContext.Provider value="text-sm text-popover-foreground select-none group-active:text-accent-foreground">
    <MenubarPrimitive.RadioItem
      className={cn(
        "active:bg-accent group relative flex min-h-11 flex-row items-center gap-2 rounded-sm py-2 pl-8 pr-2 web:min-h-0 web:py-1.5",
        Platform.select({
          web: "focus:bg-accent focus:text-accent-foreground cursor-default outline-none data-[disabled]:pointer-events-none",
        }),
        props.disabled && "opacity-50",
        className
      )}
      {...props}
    >
      <View className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <MenubarPrimitive.ItemIndicator>
          <View className="bg-foreground h-2 w-2 rounded-full" />
        </MenubarPrimitive.ItemIndicator>
      </View>
      {children}
    </MenubarPrimitive.RadioItem>
  </TextClassContext.Provider>
);

const MenubarLabel = ({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.Label> & {
  className?: string;
  inset?: boolean;
}) => (
  <MenubarPrimitive.Label
    className={cn(
      "text-foreground px-2 py-2 text-sm font-medium",
      inset && "pl-8",
      className
    )}
    {...props}
  />
);

const MenubarSeparator = ({
  className,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.Separator>) => (
  <MenubarPrimitive.Separator
    className={cn("bg-border -mx-1 my-1 h-px", className)}
    {...props}
  />
);

const MenubarShortcut = ({
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
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarGroup,
  MenubarItem,
  MenubarLabel,
  MenubarMenu,
  MenubarPortal,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
};
