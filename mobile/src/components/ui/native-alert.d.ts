import type { ComponentType } from "react";

export interface NativeAlertProps {
  cancelLabel?: string;
  confirmLabel: string;
  description: string;
  destructive?: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
}

export declare const NativeAlert: ComponentType<NativeAlertProps>;
