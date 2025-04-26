import { useCallback } from 'react';

/**
 * Types for toast manager
 */
export type ToastVariant = 'default' | 'destructive';

export interface ToastOptions {
  title: string;
  description: string;
  variant?: ToastVariant;
  action?: React.ReactNode;
}

export interface ToastContextType {
  toast: (options: ToastOptions) => void;
}

/**
 * A hook that provides toast notification functionality
 * @param toastContext The toast context from your UI library
 * @returns An object with methods to show various types of toasts
 */
export function useToastManager(toastContext: ToastContextType) {
  const { toast } = toastContext;

  const showToast = useCallback(
    ({ title, description, variant = 'default', action }: ToastOptions) => {
      toast({
        title,
        description,
        variant,
        action,
      });
    },
    [toast]
  );

  const showErrorToast = useCallback(
    (title: string, description: string, action?: React.ReactNode) => {
      showToast({
        title,
        description,
        variant: 'destructive',
        action,
      });
    },
    [showToast]
  );

  const showSuccessToast = useCallback(
    (title: string, description: string, action?: React.ReactNode) => {
      showToast({
        title,
        description,
        action,
      });
    },
    [showToast]
  );

  return {
    toast,
    showToast,
    showErrorToast,
    showSuccessToast,
  };
}
