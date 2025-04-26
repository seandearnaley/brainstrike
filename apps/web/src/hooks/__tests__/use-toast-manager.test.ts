import { PartialRefreshError } from '@brainstrike/types';
import type { ToastActionElement } from '@brainstrike/ui';
import { useToast } from '@brainstrike/ui';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FileExplorerStrings } from '../../components/custom/constants/file-explorer-constants';
import { useToastManager } from '../use-toast-manager';

// Mock dependencies
vi.mock('@brainstrike/ui', () => ({
  useToast: vi.fn().mockReturnValue({
    toast: vi.fn(),
    dismiss: vi.fn(),
    toasts: [],
  }),
}));

// Mock console.error to avoid test noise
vi.spyOn(console, 'error').mockImplementation(() => {});

describe('useToastManager', () => {
  // Setup for each test
  const setup = () => {
    const mockToast = vi.fn();
    vi.mocked(useToast).mockReturnValue({
      toast: mockToast,
      dismiss: vi.fn(),
      toasts: [],
    });
    const { result } = renderHook(() => useToastManager());
    return { result, mockToast };
  };

  describe('showToast', () => {
    it('should call toast with provided parameters', () => {
      const { result, mockToast } = setup();
      const toastParams = {
        title: 'Test Toast',
        description: 'This is a test toast',
        variant: 'default' as const,
      };

      result.current.showToast(toastParams);

      expect(mockToast).toHaveBeenCalledWith(toastParams);
    });

    it('should call toast with destructive variant', () => {
      const { result, mockToast } = setup();
      const toastParams = {
        title: 'Error Toast',
        description: 'This is an error toast',
        variant: 'destructive' as const,
      };

      result.current.showToast(toastParams);

      expect(mockToast).toHaveBeenCalledWith(toastParams);
    });

    it('should call toast with an action', () => {
      const { result, mockToast } = setup();
      // Create a mock action element
      const mockAction = {} as ToastActionElement;
      const toastParams = {
        title: 'Action Toast',
        description: 'This is a toast with action',
        action: mockAction,
      };

      result.current.showToast(toastParams);

      expect(mockToast).toHaveBeenCalledWith({
        ...toastParams,
        variant: 'default', // Default variant
      });
    });
  });

  describe('handlePartialRefreshError', () => {
    it('should show destructive toast with error message', () => {
      const { result, mockToast } = setup();
      const error = new PartialRefreshError('Partial refresh failed', 5, 3);

      result.current.handlePartialRefreshError(error);

      expect(mockToast).toHaveBeenCalledWith({
        title: FileExplorerStrings.ERROR.TITLE,
        description: 'Partial refresh failed',
        variant: 'destructive',
      });
    });
  });

  describe('handleRefreshError', () => {
    it('should handle PartialRefreshError', () => {
      const { result, mockToast } = setup();
      const error = new PartialRefreshError('Partial refresh failed', 5, 3);

      result.current.handleRefreshError(error);

      expect(mockToast).toHaveBeenCalledWith({
        title: FileExplorerStrings.ERROR.TITLE,
        description: 'Partial refresh failed',
        variant: 'destructive',
      });
    });

    it('should handle generic errors', () => {
      const { result, mockToast } = setup();
      const error = new Error('Generic error');

      result.current.handleRefreshError(error);

      expect(mockToast).toHaveBeenCalledWith({
        title: FileExplorerStrings.ERROR.TITLE,
        description: FileExplorerStrings.ERROR.REFRESH_FAILED,
        variant: 'destructive',
      });
    });
  });

  describe('handleBrowserCompatibilityError', () => {
    it('should show toast with browser compatibility error', () => {
      const { result, mockToast } = setup();
      const reason = 'Browser does not support FileSystem API';

      result.current.handleBrowserCompatibilityError(reason);

      expect(mockToast).toHaveBeenCalledWith({
        title: FileExplorerStrings.ERROR.BROWSER_COMPATIBILITY,
        description: reason,
        variant: 'destructive',
      });
    });
  });

  describe('handleDirectorySelectError', () => {
    it('should log error and show toast', () => {
      const { result, mockToast } = setup();
      const error = new Error('Failed to select directory');

      result.current.handleDirectorySelectError(error);

      expect(console.error).toHaveBeenCalledWith(
        'Failed to select root directory. Raw error:',
        error
      );
      expect(mockToast).toHaveBeenCalledWith({
        title: FileExplorerStrings.ERROR.TITLE,
        description: FileExplorerStrings.ERROR.ROOT_DIRECTORY_FAILED,
        variant: 'destructive',
      });
    });
  });

  describe('handleSelectionLimitError', () => {
    it('should show selection limit exceeded toast', () => {
      const { result, mockToast } = setup();

      result.current.handleSelectionLimitError();

      expect(mockToast).toHaveBeenCalledWith({
        title: FileExplorerStrings.ERROR.TITLE,
        description: FileExplorerStrings.ERROR.SELECTION_LIMIT_EXCEEDED,
        variant: 'destructive',
      });
    });
  });
});
