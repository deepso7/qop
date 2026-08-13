import { Host } from "@expo/ui";
import {
  AlertDialog,
  Text as NativeText,
  TextButton,
} from "@expo/ui/jetpack-compose";
import * as React from "react";

import { useTheme } from "@/constants/theme";

import type { NativeAlertProps } from "./native-alert";

// Android uses a real Material 3 dialog so its surface and actions follow QOP's theme.
const NativeAlert = React.memo(
  ({
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

    if (!open) {
      return null;
    }

    const confirmColor = destructive ? theme.destructive : theme.primary;

    return (
      <Host matchContents seedColor={theme.primary}>
        <AlertDialog
          colors={{
            containerColor: theme.backgroundElement,
            textContentColor: theme.textSecondary,
            titleContentColor: theme.text,
          }}
          onDismissRequest={close}
        >
          <AlertDialog.Title>
            <NativeText>{title}</NativeText>
          </AlertDialog.Title>
          <AlertDialog.Text>
            <NativeText>{description}</NativeText>
          </AlertDialog.Text>
          <AlertDialog.ConfirmButton>
            <TextButton
              colors={{ contentColor: confirmColor }}
              onClick={onConfirm}
            >
              <NativeText>{confirmLabel}</NativeText>
            </TextButton>
          </AlertDialog.ConfirmButton>
          <AlertDialog.DismissButton>
            <TextButton
              colors={{ contentColor: theme.primary }}
              onClick={close}
            >
              <NativeText>{cancelLabel}</NativeText>
            </TextButton>
          </AlertDialog.DismissButton>
        </AlertDialog>
      </Host>
    );
  }
);
NativeAlert.displayName = "NativeAlert";

export { NativeAlert };
