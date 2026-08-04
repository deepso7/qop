import { Users } from "lucide-react-native";
import * as React from "react";
import { Pressable, View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { Separator } from "@/components/ui/separator";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

type ChatRowSecurity = "changed" | "unverified" | "verified";

interface ChatRowProps extends React.ComponentProps<typeof Pressable> {
  avatarFallback?: string;
  draft?: boolean;
  group?: boolean;
  name: string;
  online?: boolean;
  preview: string;
  previewAuthor?: string;
  security?: ChatRowSecurity;
  showSeparator?: boolean;
  time?: string;
  unreadCount?: number;
}

const securityCopy: Record<ChatRowSecurity, string> = {
  changed: "Safety number changed",
  unverified: "Unverified contact",
  verified: "Verified contact",
};

const ChatRowIdentity = ({
  avatarFallback,
  group,
  name,
  online,
}: Pick<ChatRowProps, "avatarFallback" | "group" | "name" | "online">) => (
  <View className="relative shrink-0">
    <View
      className={cn(
        "size-14 items-center justify-center bg-background-element",
        group ? "rounded-[18px]" : "rounded-full"
      )}
      style={{ borderCurve: "continuous" }}
    >
      {group ? (
        <Icon as={Users} className="size-6 text-foreground-secondary" />
      ) : (
        <Text className="text-lg font-semibold text-foreground-secondary">
          {avatarFallback ?? name.slice(0, 2).toUpperCase()}
        </Text>
      )}
    </View>
    {online ? (
      <View
        accessibilityLabel="Online"
        className="absolute right-0 bottom-0 size-3.5 rounded-full border-2 border-background bg-primary"
      />
    ) : null}
  </View>
);

// oxlint-disable eslint/complexity -- The row renders independent chat-state indicators declaratively.
const ChatRow = React.forwardRef<
  React.ElementRef<typeof Pressable>,
  ChatRowProps
>(
  (
    {
      accessibilityHint,
      accessibilityRole,
      avatarFallback,
      className,
      disabled,
      draft = false,
      group = false,
      name,
      online = false,
      onPress,
      preview,
      previewAuthor,
      security,
      showSeparator = true,
      time,
      unreadCount = 0,
      ...props
    },
    ref
  ) => {
    const hasUnread = unreadCount > 0;
    const opensConversation = typeof onPress === "function";
    const accessibilityStatus = [
      hasUnread ? `${unreadCount} unread` : undefined,
      security ? securityCopy[security] : undefined,
      online ? "online" : undefined,
    ]
      .filter(Boolean)
      .join(", ");
    const accessibilityPreview = `${draft ? "Draft. " : ""}${previewAuthor ? `${previewAuthor}. ` : ""}${preview}`;
    const accessibilityLabel = [
      name,
      accessibilityPreview,
      time,
      accessibilityStatus,
    ]
      .filter(Boolean)
      .join(". ");

    return (
      <View className={cn("pl-4", className)}>
        <Pressable
          ref={ref}
          accessibilityHint={
            accessibilityHint ??
            (opensConversation ? "Opens the conversation" : undefined)
          }
          accessibilityLabel={accessibilityLabel}
          accessibilityRole={
            accessibilityRole ?? (opensConversation ? "button" : undefined)
          }
          className="flex-row items-center gap-3 active:bg-background-element/70"
          disabled={disabled}
          onPress={onPress}
          style={{ opacity: disabled ? 0.5 : 1 }}
          {...props}
        >
          <ChatRowIdentity
            avatarFallback={avatarFallback}
            group={group}
            name={name}
            online={online}
          />

          <View className="min-w-0 flex-1">
            <View className="min-h-20 flex-row items-center gap-3 py-3 pr-4">
              <View className="min-w-0 flex-1 gap-1">
                <View className="flex-row items-center gap-1.5">
                  <Text
                    className="min-w-0 shrink text-[17px] font-semibold leading-5"
                    numberOfLines={1}
                  >
                    {name}
                  </Text>
                </View>

                <Text
                  className={cn(
                    "text-[15px] leading-5 text-foreground-secondary",
                    hasUnread && "font-medium text-foreground"
                  )}
                  numberOfLines={1}
                >
                  {draft ? (
                    <Text className="font-medium text-destructive">
                      Draft:{" "}
                    </Text>
                  ) : null}
                  {previewAuthor ? (
                    <Text className="font-medium">{previewAuthor}: </Text>
                  ) : null}
                  {preview}
                </Text>
              </View>

              <View className="h-12 min-w-10 items-end justify-between py-0.5">
                {time ? (
                  <Text
                    className={cn(
                      "text-xs text-foreground-secondary",
                      hasUnread && "font-medium text-primary"
                    )}
                    style={{ fontVariant: ["tabular-nums"] }}
                  >
                    {time}
                  </Text>
                ) : (
                  <View />
                )}
                {hasUnread ? (
                  <View className="min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5">
                    <Text
                      className="text-xs font-semibold text-primary-foreground"
                      style={{ fontVariant: ["tabular-nums"] }}
                    >
                      {unreadCount > 99 ? "99+" : unreadCount}
                    </Text>
                  </View>
                ) : null}
              </View>
            </View>
            {showSeparator ? <Separator /> : null}
          </View>
        </Pressable>
      </View>
    );
  }
);

ChatRow.displayName = "ChatRow";
// oxlint-enable eslint/complexity

export { ChatRow };
export type { ChatRowProps, ChatRowSecurity };
