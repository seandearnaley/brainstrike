import { FileExplorerStrings, PartialRefreshError } from '@brainstrike/types';
import type { ToastActionElement } from '@brainstrike/ui';
import { useToast } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import { useCallback } from 'react';

/**
 * `useToastManager` hook for File Explorer contexts.
 *
 * This hook provides a consistent interface for managing toasts specifically tailored
 * for file explorer operations and error handling within the Brainstrike ecosystem.
 * It utilizes `@brainstrike/ui` for toast presentation and `@brainstrike/types`
 * for specific error types (e.g., `PartialRefreshError`) and strings (`FileExplorerStrings`).
 *
 * Placed in `packages/file-explorer-hooks` because its functionality is closely tied to
 * file explorer concepts and uses types/strings specific to that domain, making it
 * reusable across different file explorer implementations or related features.
 *
 * @returns An object with functions to display various file-explorer related toasts:
 *  - `toast`: The raw toast function from `@brainstrike/ui`.
 *  - `showToast`: A generic toast display function.
 *  - `handlePartialRefreshError`: Handles `PartialRefreshError` toasts.
 *  - `handleRefreshError`: Handles generic refresh errors.
 *  - `handleBrowserCompatibilityError`: Handles browser compatibility issue toasts.
 *  - `handleDirectorySelectError`: Handles errors during directory selection.
 */
const logger = createLogger('ToastManager');

export const useToastManager = () => {
  const { toast } = useToast();

  /**
   * Displays a toast notification.
   * @param {object} options - Toast options.
   * @param {string} options.title - The title of the toast.
   * @param {string} options.description - The description/content of the toast.
   * @param {'default' | 'destructive'} [options.variant='default'] - The variant of the toast.
   * @param {ToastActionElement} [options.action] - Optional action element for the toast.
   */
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
      // Define local type for toast options, consistent with useToast's expectations
      interface ResolvedToastOptions {
        action?: ToastActionElement;
        description: string;
        title: string;
        variant?: 'default' | 'destructive';
      }

      const toastOptions: ResolvedToastOptions = {
        description,
        title,
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
        description: error.message,
        title: FileExplorerStrings.error.title,
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
          description: FileExplorerStrings.error.refreshFailed,
          title: FileExplorerStrings.error.title,
          variant: 'destructive',
        });
      }
    },
    [handlePartialRefreshError, showToast]
  );

  const handleBrowserCompatibilityError = useCallback(
    (reason: string) => {
      showToast({
        description: reason,
        title: FileExplorerStrings.error.browserCompatibility,
        variant: 'destructive',
      });
    },
    [showToast]
  );

  const handleDirectorySelectError = useCallback(
    (error: unknown) => {
      logger.error('Failed to select root directory. Raw error:', error);
      showToast({
        description: FileExplorerStrings.error.rootDirectoryFailed,
        title: FileExplorerStrings.error.title,
        variant: 'destructive',
      });
    },
    [showToast]
  );

  return {
    handleBrowserCompatibilityError,
    handleDirectorySelectError,
    handlePartialRefreshError,
    handleRefreshError,
    showToast,
    toast,
  };
};
