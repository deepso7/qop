import { Host } from "@expo/ui";
import {
  Alert,
  Button as NativeButton,
  Text as NativeText,
} from "@expo/ui/swift-ui";
import { frame, opacity, tint } from "@expo/ui/swift-ui/modifiers";
import * as React from "react";

import { useTheme } from "@/constants/theme";

import type { NativeAlertProps } from "./native-alert";

// SwiftUI owns presentation and accessibility; QOP supplies semantic action colors.
const NativeAlertView = ({
  cancelLabel = "Cancel",
  confirmLabel,
  description,
  destructive = false,
  onConfirm,
  onOpenChange,
  open,
  title,
}: NativeAlertProps) => {
  const theme = useTheme();

  const close = React.useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const handlePresentationChange = React.useCallback(
    (isPresented: boolean) => {
      if (!isPresented) {
        close();
      }
    },
    [close]
  );

  return (
    <Host matchContents seedColor={theme.primary}>
      <Alert
        isPresented={open}
        onIsPresentedChange={handlePresentationChange}
        title={title}
      >
        <Alert.Trigger>
          <NativeText modifiers={[frame({ height: 1, width: 1 }), opacity(0)]}>
            {" "}
          </NativeText>
        </Alert.Trigger>
        <Alert.Message>
          <NativeText>{description}</NativeText>
        </Alert.Message>
        <Alert.Actions>
          {/* SwiftUI Button.Role.cancel — not an ARIA role. */}
          {/* oxlint-disable-next-line jsx-a11y/aria-role -- SwiftUI cancel role is required for alert dismissal semantics. */}
          <NativeButton label={cancelLabel} onPress={close} role="cancel" />
          <NativeButton
            label={confirmLabel}
            modifiers={[tint(destructive ? theme.destructive : theme.primary)]}
            onPress={onConfirm}
            role={destructive ? "destructive" : "default"}
          />
        </Alert.Actions>
      </Alert>
    </Host>
  );
};

const NativeAlert = React.memo(NativeAlertView);
NativeAlert.displayName = "NativeAlert";

export { NativeAlert };
