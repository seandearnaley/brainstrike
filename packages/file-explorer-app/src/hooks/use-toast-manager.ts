/**
 * Toast Manager Hook
 *
 * This hook provides a consistent interface for managing toasts in the file explorer.
 * It handles common toast patterns and error handling.
 */

import { PartialRefreshError } from '@brainstrike/types';
import { FileExplorerStrings } from '@brainstrike/types';
import type { ToastActionElement } from '@brainstrike/ui';
import { useToast } from '@brainstrike/ui';
import { useCallback } from 'react';

// Interface for a generic error with potential name and message properties
interface GenericError {
  name?: string;
  message?: string;
}

// Helper function to check if an object is a generic error
function isGenericError(error: unknown): error is GenericError {
  return typeof error === 'object' && error !== null;
}

export const useToastManager = () => {
  const { toast } = useToast();

  const showToast = useCallback(
    ({
      title,
      description,
      variant = 'default',
      action,
    }: {
      title: string;
      description: string;
      variant?: 'default' | 'destructive';
      action?: ToastActionElement;
    }) => {
      // Define local type for toast options
      type ToastOptions = {
        title: string;
        description: string;
        variant?: 'default' | 'destructive';
        action?: ToastActionElement;
      };

      // Construct the toast options object conditionally
      const toastOptions: ToastOptions = {
        title,
        description,
        variant,
      };
      if (action) {
        toastOptions.action = action;
      }
      toast(toastOptions);
    },
    [toast]
  );

  const handlePartialRefreshError = useCallback(
    (error: PartialRefreshError) => {
      showToast({
        title: FileExplorerStrings.error.title,
        description: error.message,
        variant: 'destructive',
      });
    },
    [showToast]
  );

  const handleRefreshError = useCallback(
    (error: unknown) => {
      if (error instanceof PartialRefreshError) {
        handlePartialRefreshError(error);
      } else {
        showToast({
          title: FileExplorerStrings.error.title,
          description: FileExplorerStrings.error.refreshFailed,
          variant: 'destructive',
        });
      }
    },
    [handlePartialRefreshError, showToast]
  );

  const handleBrowserCompatibilityError = useCallback(
    (reason: string) => {
      showToast({
        title: FileExplorerStrings.error.browserCompatibility,
        description: reason,
        variant: 'destructive',
      });
    },
    [showToast]
  );

  const handleDirectorySelectError = useCallback(
    (error: unknown) => {
      // Log detailed error information
      console.error('Failed to select root directory. Raw error:', error);
      if (isGenericError(error)) {
        console.error(`Error Name: ${error.name}, Error Message: ${error.message}`);
      }
      showToast({
        title: FileExplorerStrings.error.title,
        description: FileExplorerStrings.error.rootDirectoryFailed,
        variant: 'destructive',
      });
    },
    [showToast]
  );

  const handleSelectionLimitError = useCallback(() => {
    toast({
      title: FileExplorerStrings.error.title,
      description: FileExplorerStrings.error.selectionLimitExceeded,
      variant: 'destructive',
    });
  }, [toast]);

  return {
    toast,
    showToast,
    handlePartialRefreshError,
    handleRefreshError,
    handleBrowserCompatibilityError,
    handleDirectorySelectError,
    handleSelectionLimitError,
  };
};
