import * as React from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Text } from "@/components/ui/text";

import type { NativeAlertProps } from "./native-alert.types";

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
  }: NativeAlertProps) => (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            <Text>{cancelLabel}</Text>
          </AlertDialogCancel>
          <AlertDialogAction
            onPress={onConfirm}
            variant={destructive ? "destructive" : "default"}
          >
            <Text>{confirmLabel}</Text>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
);
NativeAlert.displayName = "NativeAlert";

export { NativeAlert };
export type { NativeAlertProps } from "./native-alert.types";
