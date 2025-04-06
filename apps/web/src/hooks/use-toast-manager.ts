/**
 * Toast Manager Hook
 *
 * This hook provides a consistent interface for managing toasts in the file explorer.
 * It handles common toast patterns and error handling.
 */

import { PartialRefreshError } from '@brainstrike/types';
import type { ToastActionElement } from '@brainstrike/ui';
import { useToast } from '@brainstrike/ui';
import { useCallback } from 'react';
import { FileExplorerStrings } from '../components/custom/constants/file-explorer-constants';

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
      toast({
        title,
        description,
        variant,
        action,
      });
    },
    [toast]
  );

  const handlePartialRefreshError = useCallback(
    (error: PartialRefreshError) => {
      showToast({
        title: FileExplorerStrings.ERROR.TITLE,
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
          title: FileExplorerStrings.ERROR.TITLE,
          description: FileExplorerStrings.ERROR.REFRESH_FAILED,
          variant: 'destructive',
        });
      }
    },
    [handlePartialRefreshError, showToast]
  );

  const handleBrowserCompatibilityError = useCallback(
    (reason: string) => {
      showToast({
        title: FileExplorerStrings.ERROR.BROWSER_COMPATIBILITY,
        description: reason,
        variant: 'destructive',
      });
    },
    [showToast]
  );

  const handleDirectorySelectError = useCallback(
    (error: unknown) => {
      console.error('Failed to select root directory:', error);
      showToast({
        title: FileExplorerStrings.ERROR.TITLE,
        description: FileExplorerStrings.ERROR.ROOT_DIRECTORY_FAILED,
        variant: 'destructive',
      });
    },
    [showToast]
  );

  const handleSelectionLimitError = useCallback(() => {
    toast({
      title: FileExplorerStrings.ERROR.TITLE,
      description: FileExplorerStrings.ERROR.SELECTION_LIMIT_EXCEEDED,
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
