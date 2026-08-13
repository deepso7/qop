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
