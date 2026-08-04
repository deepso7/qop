import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import { Portal } from "@rn-primitives/portal";
import type { LucideIcon } from "lucide-react-native";
import { Check, CheckCheck, Clock3, Plus } from "lucide-react-native";
import * as React from "react";
import {
  AccessibilityInfo,
  InteractionManager,
  Platform,
  Pressable,
  StyleSheet,
  View,
  findNodeHandle,
  useColorScheme,
  useWindowDimensions,
} from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  FadeOut,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

import { Button } from "@/components/ui/button";
import type { ButtonProps } from "@/components/ui/button";
import { useBlurTarget } from "@/components/ui/blur-target";
import { Icon } from "@/components/ui/icon";
import { Text, TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";

const MessageContext = React.createContext<"start" | "end">("start");

type MessageProps = React.ComponentProps<typeof View> & {
  align?: "start" | "end";
};

const Message = ({ align = "start", className, ...props }: MessageProps) => (
  <MessageContext.Provider value={align}>
    <View
      className={cn(
        "w-full flex-row items-end gap-2",
        align === "end" && "justify-end",
        className
      )}
      {...props}
    />
  </MessageContext.Provider>
);

const MessageGroup = ({
  className,
  ...props
}: React.ComponentProps<typeof View>) => (
  <View className={cn("w-full gap-1.5", className)} {...props} />
);

const MessageAvatar = ({
  className,
  ...props
}: React.ComponentProps<typeof View>) => {
  const align = React.use(MessageContext);
  return (
    <View
      className={cn("shrink-0", align === "end" && "order-2", className)}
      {...props}
    />
  );
};

const MessageContent = ({
  className,
  ...props
}: React.ComponentProps<typeof View>) => {
  const align = React.use(MessageContext);
  return (
    <View
      className={cn(
        "max-w-[85%] gap-1",
        align === "end" ? "items-end" : "items-start",
        className
      )}
      {...props}
    />
  );
};

const MessageHeader = ({
  className,
  ...props
}: React.ComponentProps<typeof View>) => (
  <View className={cn("px-2", className)} {...props} />
);

const MessageFooter = ({
  className,
  ...props
}: React.ComponentProps<typeof View>) => {
  const align = React.use(MessageContext);
  return (
    <View
      className={cn(
        "flex-row items-center gap-1.5 px-1",
        align === "end" && "justify-end",
        className
      )}
      {...props}
    />
  );
};

const messageBubbleVariants = cva("px-4 py-2.5", {
  defaultVariants: { tone: "incoming" },
  variants: {
    tone: {
      failed: "rounded-[22px] border-2 border-destructive bg-primary",
      incoming: "rounded-[22px] bg-background-element",
      outgoing: "rounded-[22px] bg-primary",
      pending: "rounded-[22px] bg-primary/55",
    },
  },
});

type MessageBubbleProps = React.ComponentProps<typeof View> &
  VariantProps<typeof messageBubbleVariants> & {
    position?: "first" | "last" | "middle" | "single";
  };

const MessageBubble = ({
  children,
  className,
  position,
  style,
  tone,
  ...props
}: MessageBubbleProps) => {
  const align = React.use(MessageContext);
  const resolvedPosition = position ?? "single";
  const textClassName =
    tone === "outgoing" || tone === "failed"
      ? "text-primary-foreground"
      : undefined;

  return (
    <TextClassContext.Provider value={textClassName}>
      <View
        className={cn(
          messageBubbleVariants({ tone }),
          align === "start" && resolvedPosition === "single" && "rounded-bl-md",
          align === "end" && resolvedPosition === "single" && "rounded-br-md",
          align === "start" && resolvedPosition === "first" && "rounded-bl-md",
          align === "end" && resolvedPosition === "first" && "rounded-br-md",
          align === "start" &&
            (resolvedPosition === "middle" || resolvedPosition === "last") &&
            "rounded-l-md",
          align === "end" &&
            (resolvedPosition === "middle" || resolvedPosition === "last") &&
            "rounded-r-md",
          className
        )}
        style={[{ borderCurve: "continuous" }, style]}
        {...props}
      >
        {children}
      </View>
    </TextClassContext.Provider>
  );
};

type MessageStatusProps = React.ComponentProps<typeof Pressable> & {
  label: string;
  tone?: "default" | "failed";
};

const MessageStatus = ({
  className,
  disabled,
  label,
  tone = "default",
  ...props
}: MessageStatusProps) => (
  <Pressable
    accessibilityRole={disabled ? undefined : "button"}
    className={cn("px-1", className)}
    disabled={disabled}
    {...props}
  >
    <Text
      className={cn(
        "text-foreground-secondary text-xs leading-4",
        tone === "failed" && "text-destructive font-semibold"
      )}
      selectable
    >
      {label}
    </Text>
  </Pressable>
);

const MessageDate = ({
  className,
  ...props
}: React.ComponentProps<typeof Text>) => (
  <Text
    className={cn(
      "text-foreground-secondary bg-background-element self-center rounded-full px-3 py-1 text-xs",
      className
    )}
    selectable
    {...props}
  />
);

type MessageReplyProps = React.ComponentProps<typeof View> & {
  author: string;
  preview: string;
};

const MessageReply = ({
  author,
  className,
  preview,
  ...props
}: MessageReplyProps) => (
  <View className={cn("mb-2 flex-row gap-2", className)} {...props}>
    <View className="bg-primary w-0.5 rounded-full" />
    <View className="min-w-0 flex-1">
      <Text className="text-primary text-xs font-semibold" selectable>
        {author}
      </Text>
      <Text
        className="text-foreground-secondary text-xs"
        numberOfLines={1}
        selectable
      >
        {preview}
      </Text>
    </View>
  </View>
);

type MessageMetaProps = React.ComponentProps<typeof View> & {
  status?: "read" | "sending" | "sent";
  time: string;
};

const MessageMeta = ({
  className,
  status,
  time,
  ...props
}: MessageMetaProps) => {
  const StatusIcon =
    status === "read" ? CheckCheck : status === "sent" ? Check : Clock3;

  return (
    <View
      accessibilityLabel={`${time}${status ? `, ${status}` : ""}`}
      className={cn(
        "mt-1 flex-row items-center gap-1 self-end opacity-65",
        className
      )}
      {...props}
    >
      <Text className="text-xs leading-4" style={{ fontVariant: ["tabular-nums"] }}>
        {time}
      </Text>
      {status ? <Icon as={StatusIcon} className="size-3.5" strokeWidth={2.25} /> : null}
    </View>
  );
};

const MessageReactions = ({
  className,
  ...props
}: React.ComponentProps<typeof View>) => {
  const align = React.use(MessageContext);
  return (
    <View
      className={cn(
        "-mt-3 flex-row flex-wrap items-center gap-1 px-3",
        align === "end" && "justify-end",
        className
      )}
      {...props}
    />
  );
};

type MessageReactionProps = Omit<
  ButtonProps,
  "children" | "size" | "variant"
> & {
  emoji: string;
  selected?: boolean;
};

const MessageReaction = ({
  className,
  emoji,
  selected = false,
  ...props
}: MessageReactionProps) => {
  return (
    <Button
      accessibilityLabel={`${emoji} reaction${selected ? ", you reacted" : ""}`}
      accessibilityState={{ selected }}
      className={cn(
        "border-border h-8 min-w-8 rounded-full border px-2",
        selected && "bg-primary border-primary",
        className
      )}
      hitSlop={6}
      size="sm"
      variant={selected ? "default" : "outline"}
      {...props}
    >
      <Text className="text-sm leading-4">{emoji}</Text>
    </Button>
  );
};

const MessageReactionAdd = ({ className, ...props }: ButtonProps) => (
  <Button
    accessibilityLabel="Add reaction"
    className={cn("border-border size-8 rounded-full border", className)}
    hitSlop={6}
    size="icon"
    variant="outline"
    {...props}
  >
    <Icon as={Plus} className="size-4" />
  </Button>
);

const MessageReactionPicker = ({
  className,
  ...props
}: React.ComponentProps<typeof View>) => (
  <View
    accessibilityLabel="Choose a reaction"
    accessibilityRole="toolbar"
    className={cn(
      "border-border bg-background-element self-start flex-row items-center gap-0.5 rounded-full border p-1.5",
      className
    )}
    {...props}
  />
);

type MessageReactionPickerItemProps = Omit<
  ButtonProps,
  "children" | "size" | "variant"
> & {
  emoji: string;
};

const MessageReactionPickerItem = ({
  className,
  emoji,
  ...props
}: MessageReactionPickerItemProps) => (
  <Button
    accessibilityLabel={`React with ${emoji}`}
    className={cn("size-11 rounded-full p-0", className)}
    size="icon"
    variant="ghost"
    {...props}
  >
    <Text className="text-2xl leading-7">{emoji}</Text>
  </Button>
);

type MessageAction = {
  destructive?: boolean;
  disabled?: boolean;
  icon: LucideIcon;
  id: string;
  label: string;
  onPress?: () => void;
  separatorBefore?: boolean;
};

type MessageLongPressMenuProps = {
  accessibilityLabel?: string;
  actions: MessageAction[];
  align?: "start" | "end";
  children: React.ReactNode;
  delayLongPress?: number;
  onAddReaction?: () => void;
  onOpenChange?: (open: boolean) => void;
  onReaction?: (emoji: string) => void;
  reactions?: string[];
};

type MessageRect = {
  height: number;
  width: number;
  x: number;
  y: number;
};

const ACTION_MENU_WIDTH = 252;
const REACTION_RAIL_HEIGHT = 58;
const MENU_ROW_HEIGHT = 46;

const MessageLongPressMenu = ({
  accessibilityLabel = "Open message actions",
  actions,
  align = "start",
  children,
  delayLongPress = 350,
  onAddReaction,
  onOpenChange,
  onReaction,
  reactions = ["👍", "❤️", "😂", "😮", "😢", "🙏"],
}: MessageLongPressMenuProps) => {
  const triggerRef = React.useRef<View>(null);
  const firstActionRef = React.useRef<View>(null);
  const wasOpen = React.useRef(false);
  const portalName = React.useId();
  const [open, setOpen] = React.useState(false);
  const [rect, setRect] = React.useState<MessageRect | null>(null);
  const reduceMotion = useReducedMotion();
  const colorScheme = useColorScheme();
  const blurTarget = useBlurTarget();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const surfaceWidth = Math.min(360, windowWidth - 32);

  const setMenuOpen = React.useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [onOpenChange]
  );

  const showMenu = React.useCallback(() => {
    triggerRef.current?.measureInWindow((x, y, width, height) => {
      setRect({ height, width, x, y });
      setMenuOpen(true);

      const feedback =
        process.env.EXPO_OS === "android"
          ? Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Long_Press)
          : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      void feedback.catch(() => undefined);
    });
  }, [setMenuOpen]);

  const runAndClose = React.useCallback(
    (callback?: () => void) => {
      setMenuOpen(false);
      callback?.();
    },
    [setMenuOpen]
  );

  const separators = actions.filter((action) => action.separatorBefore).length;
  const menuHeight = actions.length * MENU_ROW_HEIGHT + separators;
  const groupHeight =
    REACTION_RAIL_HEIGHT + 10 + (rect?.height ?? 0) + 12 + menuHeight;
  const desiredTop = (rect?.y ?? 0) - REACTION_RAIL_HEIGHT - 10;
  const top = Math.max(54, Math.min(desiredTop, windowHeight - groupHeight - 24));
  const desiredLeft =
    align === "end"
      ? (rect?.x ?? 0) + (rect?.width ?? 0) - surfaceWidth
      : (rect?.x ?? 0);
  const left = Math.max(16, Math.min(desiredLeft, windowWidth - surfaceWidth - 16));

  React.useEffect(() => {
    blurTarget?.setOverlayOpen(open);

    if (open) {
      AccessibilityInfo.announceForAccessibility("Message actions opened");
      const task = InteractionManager.runAfterInteractions(() => {
        requestAnimationFrame(() => {
          const actionNode = findNodeHandle(firstActionRef.current);
          if (actionNode) {
            AccessibilityInfo.setAccessibilityFocus(actionNode);
          }
        });
      });
      wasOpen.current = true;
      return () => task.cancel();
    }

    if (wasOpen.current) {
      wasOpen.current = false;
      requestAnimationFrame(() => {
        const triggerNode = findNodeHandle(triggerRef.current);
        if (triggerNode) {
          AccessibilityInfo.setAccessibilityFocus(triggerNode);
        }
      });
    }

    return undefined;
  }, [blurTarget, open]);

  React.useEffect(
    () => () => {
      blurTarget?.setOverlayOpen(false);
    },
    [blurTarget]
  );

  return (
    <>
      <View collapsable={false} ref={triggerRef}>
        <Pressable
          accessibilityHint="Shows reactions and message actions"
          accessibilityLabel={accessibilityLabel}
          accessibilityRole="button"
          delayLongPress={delayLongPress}
          onLongPress={showMenu}
        >
          {children}
        </Pressable>
      </View>

      {open && rect ? (
        <Portal name={`message-actions-${portalName}`}>
          <Animated.View
            accessibilityLabel="Message actions"
            accessibilityViewIsModal
            className="absolute inset-0"
            entering={FadeIn.duration(reduceMotion ? 80 : 140)}
            exiting={FadeOut.duration(reduceMotion ? 80 : 140)}
            onAccessibilityEscape={() => setMenuOpen(false)}
          >
            <BlurView
              blurMethod="dimezisBlurView"
              blurReductionFactor={2}
              blurTarget={blurTarget?.ref}
              intensity={Platform.OS === "ios" ? 18 : 42}
              style={StyleSheet.absoluteFill}
              tint={
                Platform.OS === "ios"
                  ? "default"
                  : colorScheme === "dark"
                    ? "dark"
                    : "light"
              }
            />
            <Pressable
              accessibilityLabel="Close message actions"
              accessibilityRole="button"
              className={cn(
                "absolute inset-0",
                Platform.OS === "ios" ? "bg-black/20" : "bg-black/30"
              )}
              onPress={() => setMenuOpen(false)}
            />

            <Animated.View
              entering={reduceMotion ? undefined : FadeIn.duration(160)}
              pointerEvents="box-none"
              style={{ left, position: "absolute", top, width: surfaceWidth }}
            >
              <Animated.View
                entering={reduceMotion ? undefined : FadeInDown.springify().damping(18).stiffness(260)}
              >
                <MessageReactionPicker className="bg-background border-border shadow-lg">
                  {reactions.map((emoji) => (
                    <MessageReactionPickerItem
                      emoji={emoji}
                      key={emoji}
                      onPress={() =>
                        runAndClose(() => onReaction?.(emoji))
                      }
                    />
                  ))}
                  <MessageReactionAdd
                    className="bg-background-selected border-0"
                    onPress={() => runAndClose(onAddReaction)}
                  />
                </MessageReactionPicker>
              </Animated.View>

              <View
                className={align === "end" ? "self-end" : "self-start"}
                pointerEvents="none"
                style={{ marginTop: 10, width: rect.width }}
              >
                <MessageContext.Provider value={align}>
                  {children}
                </MessageContext.Provider>
              </View>

              <Animated.View
                className={
                  align === "end"
                    ? "bg-background mt-3 self-end overflow-hidden rounded-[20px]"
                    : "bg-background mt-3 self-start overflow-hidden rounded-[20px]"
                }
                entering={reduceMotion ? undefined : FadeInDown.delay(35).duration(180)}
                style={{ borderCurve: "continuous", width: ACTION_MENU_WIDTH }}
              >
                {actions.map((action, index) => (
                  <React.Fragment key={action.id}>
                    {action.separatorBefore ? (
                      <View className="bg-border mx-5 h-px" />
                    ) : null}
                    <Pressable
                      accessibilityRole="menuitem"
                      accessibilityState={{ disabled: action.disabled }}
                      className="active:bg-background-selected h-[46px] flex-row items-center gap-3.5 px-4"
                      disabled={action.disabled}
                      onPress={() => runAndClose(action.onPress)}
                      ref={index === 0 ? firstActionRef : undefined}
                    >
                      <Icon
                        as={action.icon}
                        className={action.destructive ? "text-destructive size-[18px]" : "size-[18px]"}
                      />
                      <Text
                        className={
                          action.destructive ? "text-destructive text-sm" : "text-sm"
                        }
                      >
                        {action.label}
                      </Text>
                    </Pressable>
                  </React.Fragment>
                ))}
              </Animated.View>
            </Animated.View>
          </Animated.View>
        </Portal>
      ) : null}
    </>
  );
};

const MessageReactors = ({
  className,
  ...props
}: React.ComponentProps<typeof View>) => (
  <View
    className={cn(
      "bg-background-element border-border overflow-hidden rounded-[18px] border",
      className
    )}
    style={{ borderCurve: "continuous" }}
    {...props}
  />
);

type MessageReactorProps = React.ComponentProps<typeof View> & {
  actionLabel?: string;
  emoji: string;
  meta?: string;
  name: string;
  onAction?: () => void;
  showSeparator?: boolean;
};

const MessageReactor = ({
  actionLabel,
  className,
  emoji,
  meta,
  name,
  onAction,
  showSeparator = true,
  ...props
}: MessageReactorProps) => (
  <View
    className={cn(
      "min-h-14 flex-row items-center gap-3 px-4",
      showSeparator && "border-border border-b",
      className
    )}
    {...props}
  >
    <Text className="text-lg">{emoji}</Text>
    <Text className="min-w-0 flex-1 font-medium" selectable>
      {name}
    </Text>
    {actionLabel ? (
      <Pressable accessibilityRole="button" hitSlop={8} onPress={onAction}>
        <Text className="text-primary text-sm font-semibold">
          {actionLabel}
        </Text>
      </Pressable>
    ) : (
      <Text
        className="text-foreground-secondary text-sm"
        selectable
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {meta}
      </Text>
    )}
  </View>
);

type MessageAttachmentProps = React.ComponentProps<typeof Pressable> & {
  name: string;
  preview?: React.ReactNode;
  size?: string;
};

const MessageAttachment = ({
  className,
  name,
  preview,
  size,
  style,
  ...props
}: MessageAttachmentProps) => (
  <Pressable
    accessibilityLabel={`${name}${size ? `, ${size}` : ""}`}
    accessibilityRole="button"
    className={cn(
      "bg-background-element w-56 overflow-hidden rounded-[20px]",
      className
    )}
    style={[
      { borderCurve: "continuous" },
      typeof style === "function" ? undefined : style,
    ]}
    {...props}
  >
    {preview ? <View className="h-36">{preview}</View> : null}
    <View className="px-4 py-2.5">
      <Text className="text-sm" numberOfLines={1} selectable>
        {name}
        {size ? ` · ${size}` : ""}
      </Text>
    </View>
  </Pressable>
);

const MessageTypingDot = ({ index }: { index: number }) => {
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(0);

  React.useEffect(() => {
    if (reduceMotion) {
      progress.set(0);
      return;
    }

    progress.set(
      withDelay(
        index * 110,
        withRepeat(
          withSequence(
            withTiming(1, {
              duration: 180,
              easing: Easing.out(Easing.cubic),
            }),
            withTiming(0, {
              duration: 240,
              easing: Easing.inOut(Easing.cubic),
            }),
            withDelay(360, withTiming(0, { duration: 0 }))
          ),
          -1
        )
      )
    );

    return () => cancelAnimation(progress);
  }, [index, progress, reduceMotion]);

  const animatedStyle = useAnimatedStyle(() => {
    const value = progress.get();
    return {
      opacity: 0.55 + value * 0.45,
      transform: [{ translateY: value * -2 }, { scale: 1 + value * 0.12 }],
    };
  }, [progress]);

  return (
    <Animated.View
      className="bg-foreground-secondary size-1.5 rounded-full"
      style={animatedStyle}
    />
  );
};

type MessageTypingProps = React.ComponentProps<typeof View> & {
  label?: string;
};

const MessageTyping = ({
  className,
  label = "Typing",
  ...props
}: MessageTypingProps) => (
  <View
    accessibilityLabel={label}
    accessibilityLiveRegion="polite"
    accessibilityRole="text"
    className={cn(
      "bg-background-element h-9 flex-row items-center gap-1.5 self-start rounded-full px-4",
      className
    )}
    {...props}
  >
    {[0, 1, 2].map((index) => (
      <MessageTypingDot index={index} key={index} />
    ))}
  </View>
);

const MessageSystem = ({
  className,
  ...props
}: React.ComponentProps<typeof Text>) => (
  <Text
    className={cn(
      "text-foreground-secondary self-center text-center text-xs",
      className
    )}
    selectable
    {...props}
  />
);

export {
  Message,
  MessageAttachment,
  MessageAvatar,
  MessageBubble,
  MessageContent,
  MessageDate,
  MessageFooter,
  MessageGroup,
  MessageHeader,
  MessageLongPressMenu,
  MessageMeta,
  MessageReply,
  MessageReaction,
  MessageReactionAdd,
  MessageReactionPicker,
  MessageReactionPickerItem,
  MessageReactions,
  MessageReactor,
  MessageReactors,
  MessageStatus,
  MessageSystem,
  MessageTyping,
  messageBubbleVariants,
};

export type { MessageAction, MessageLongPressMenuProps };
export type { MessageBubbleProps, MessageMetaProps, MessageProps };
