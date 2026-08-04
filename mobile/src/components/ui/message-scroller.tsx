import { FlashList } from "@shopify/flash-list";
import type { FlashListProps, FlashListRef } from "@shopify/flash-list";
import { ArrowDown } from "lucide-react-native";
import * as React from "react";
import { View } from "react-native";
import type {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useResolveClassNames } from "uniwind";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

interface MessageScrollerHandle {
  scrollToIndex: (index: number, animated?: boolean) => void;
  scrollToLatest: (animated?: boolean) => void;
  scrollToMessage: (messageId: string, animated?: boolean) => boolean;
  scrollToStart: (animated?: boolean) => void;
}

type MessageScrollerProps<ItemT> = Omit<
  FlashListProps<ItemT>,
  | "contentInsetAdjustmentBehavior"
  | "maintainVisibleContentPosition"
  | "onContentSizeChange"
  | "onLayout"
  | "onScroll"
  | "scrollEventThrottle"
> & {
  className?: string;
  contentClassName?: string;
  followOutput?: boolean;
  getMessageId: (item: ItemT) => string;
  initialMessageId?: string;
  initialScrollPosition?: "start" | "end";
  jumpToLatestLabel?: string;
  maintainVisibleContentPosition?:
    | FlashListProps<ItemT>["maintainVisibleContentPosition"]
    | false;
  newMessageCount?: number;
  onAtLatestChange?: (atLatest: boolean) => void;
  onContentSizeChange?: FlashListProps<ItemT>["onContentSizeChange"];
  onLayout?: FlashListProps<ItemT>["onLayout"];
  onScroll?: FlashListProps<ItemT>["onScroll"];
  scrollEdgeThreshold?: number;
};

const DEFAULT_SCROLL_EDGE_THRESHOLD = 8;

const MessageScrollerInner = <ItemT,>(
  {
    className,
    contentClassName,
    contentContainerStyle,
    data,
    followOutput = true,
    getMessageId,
    initialMessageId,
    initialScrollPosition = "end",
    jumpToLatestLabel = "Latest",
    maintainVisibleContentPosition,
    newMessageCount = 0,
    onAtLatestChange,
    onContentSizeChange,
    onLayout,
    onLoad,
    onScroll,
    scrollEdgeThreshold = DEFAULT_SCROLL_EDGE_THRESHOLD,
    ...props
  }: MessageScrollerProps<ItemT>,
  forwardedRef: React.ForwardedRef<MessageScrollerHandle>
) => {
  const listRef = React.useRef<FlashListRef<ItemT>>(null);
  const reduceMotion = useReducedMotion();
  const listOpacity = useSharedValue(reduceMotion ? 1 : 0);
  const contentClassStyle = useResolveClassNames(
    cn("gap-2 px-4 py-3", contentClassName)
  );
  const hasInitialPosition = React.useRef(false);
  const isAtLatest = React.useRef(true);
  const isFollowing = React.useRef(initialScrollPosition === "end");
  const itemIndexById = React.useMemo(() => {
    const index = new Map<string, number>();
    if (data) {
      for (let itemIndex = 0; itemIndex < data.length; itemIndex += 1) {
        index.set(getMessageId(data[itemIndex]), itemIndex);
      }
    }
    return index;
  }, [data, getMessageId]);
  const [showJumpToLatest, setShowJumpToLatest] = React.useState(false);
  const listAnimatedStyle = useAnimatedStyle(() => ({
    opacity: listOpacity.get(),
  }));
  const shouldStartFromBottom =
    !initialMessageId && initialScrollPosition === "end";
  const resolvedMaintainVisibleContentPosition = React.useMemo(() => {
    if (maintainVisibleContentPosition === false) {
      return {
        disabled: true,
        startRenderingFromBottom: shouldStartFromBottom,
      };
    }

    return {
      ...maintainVisibleContentPosition,
      animateAutoScrollToBottom:
        maintainVisibleContentPosition?.animateAutoScrollToBottom ?? false,
      autoscrollToBottomThreshold:
        maintainVisibleContentPosition?.autoscrollToBottomThreshold ??
        (followOutput ? 0.2 : undefined),
      startRenderingFromBottom:
        maintainVisibleContentPosition?.startRenderingFromBottom ??
        shouldStartFromBottom,
    };
  }, [followOutput, maintainVisibleContentPosition, shouldStartFromBottom]);

  const updateLatestState = React.useCallback(
    (atLatest: boolean) => {
      if (isAtLatest.current === atLatest) {
        return;
      }

      isAtLatest.current = atLatest;
      setShowJumpToLatest(!atLatest);
      onAtLatestChange?.(atLatest);
    },
    [onAtLatestChange]
  );

  const scrollToLatest = React.useCallback(
    (animated = true) => {
      isFollowing.current = true;
      updateLatestState(true);
      listRef.current?.scrollToEnd({ animated });
    },
    [updateLatestState]
  );

  React.useImperativeHandle(
    forwardedRef,
    () => ({
      scrollToIndex: (index, animated = true) => {
        isFollowing.current = false;
        updateLatestState(false);
        listRef.current?.scrollToIndex({ animated, index, viewPosition: 0.15 });
      },
      scrollToLatest,
      scrollToMessage: (messageId, animated = true) => {
        const index = itemIndexById.get(messageId);
        if (index === undefined) {
          return false;
        }
        isFollowing.current = false;
        updateLatestState(false);
        listRef.current?.scrollToIndex({ animated, index, viewPosition: 0.15 });
        return true;
      },
      scrollToStart: (animated = true) => {
        isFollowing.current = false;
        updateLatestState(false);
        listRef.current?.scrollToOffset({ animated, offset: 0 });
      },
    }),
    [itemIndexById, scrollToLatest, updateLatestState]
  );

  const handleScroll = React.useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } =
        event.nativeEvent;
      const distanceFromEnd = Math.max(
        0,
        contentSize.height - layoutMeasurement.height - contentOffset.y
      );
      const atLatest = distanceFromEnd <= scrollEdgeThreshold;

      isFollowing.current = atLatest;
      updateLatestState(atLatest);
      onScroll?.(event);
    },
    [onScroll, scrollEdgeThreshold, updateLatestState]
  );

  const handleContentSizeChange = React.useCallback(
    (width: number, height: number) => {
      onContentSizeChange?.(width, height);

      if (!hasInitialPosition.current) {
        hasInitialPosition.current = true;
        const initialMessageIndex = initialMessageId
          ? itemIndexById.get(initialMessageId)
          : undefined;
        if (initialMessageIndex !== undefined) {
          isFollowing.current = false;
          updateLatestState(false);
          requestAnimationFrame(() =>
            listRef.current?.scrollToIndex({
              animated: false,
              index: initialMessageIndex,
              viewPosition: 0.15,
            })
          );
        }
      }
    },
    [initialMessageId, itemIndexById, onContentSizeChange, updateLatestState]
  );

  const handleLayout = React.useCallback(
    (event: LayoutChangeEvent) => {
      onLayout?.(event);
    },
    [onLayout]
  );

  const handleLoad = React.useCallback<
    NonNullable<FlashListProps<ItemT>["onLoad"]>
  >(
    (info) => {
      onLoad?.(info);
      listOpacity.set(reduceMotion ? 1 : withTiming(1, { duration: 120 }));
    },
    [listOpacity, onLoad, reduceMotion]
  );

  const jumpLabel =
    newMessageCount > 0
      ? `${jumpToLatestLabel} · ${newMessageCount}`
      : jumpToLatestLabel;

  return (
    <View className={cn("relative flex-1", className)}>
      <Animated.View className="flex-1" style={listAnimatedStyle}>
        <FlashList
          {...props}
          contentContainerStyle={[contentClassStyle, contentContainerStyle]}
          contentInsetAdjustmentBehavior="automatic"
          data={data}
          keyboardDismissMode={
            props.keyboardDismissMode ??
            (process.env.EXPO_OS === "ios" ? "interactive" : "on-drag")
          }
          keyboardShouldPersistTaps={
            props.keyboardShouldPersistTaps ?? "handled"
          }
          keyExtractor={props.keyExtractor ?? getMessageId}
          maintainVisibleContentPosition={
            resolvedMaintainVisibleContentPosition
          }
          onContentSizeChange={handleContentSizeChange}
          onLayout={handleLayout}
          onLoad={handleLoad}
          onScroll={handleScroll}
          ref={listRef}
          scrollEventThrottle={16}
          style={{ flex: 1 }}
        />
      </Animated.View>

      {showJumpToLatest ? (
        <Animated.View
          className="absolute right-4 bottom-4"
          entering={FadeIn.duration(160)}
          exiting={FadeOut.duration(120)}
        >
          <Button
            accessibilityLabel={jumpLabel}
            className="rounded-full px-3"
            onPress={() => scrollToLatest()}
            size="sm"
            variant="secondary"
          >
            <Icon as={ArrowDown} className="size-4" />
            <Text>{jumpLabel}</Text>
          </Button>
        </Animated.View>
      ) : null}
    </View>
  );
};

const MessageScroller = React.forwardRef(MessageScrollerInner) as <ItemT>(
  props: MessageScrollerProps<ItemT> &
    React.RefAttributes<MessageScrollerHandle>
) => React.ReactElement;

export { MessageScroller };
export type { MessageScrollerHandle, MessageScrollerProps };
