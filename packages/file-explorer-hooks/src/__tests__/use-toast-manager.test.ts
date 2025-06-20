import { PartialRefreshError } from '@brainstrike/types';
import { FileExplorerStrings } from '@brainstrike/types';
import type { ToastActionElement } from '@brainstrike/ui';
import { useToast } from '@brainstrike/ui';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastManager } from '../use-toast-manager';

// Mock dependencies
vi.mock('@brainstrike/ui', () => ({
  useToast: vi.fn(),
}));

describe('useToastManager', () => {
  let mockToast: ReturnType<typeof vi.fn>;
  let mockDismiss: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();

    // Setup fresh mocks for useToast
    mockToast = vi.fn();
    mockDismiss = vi.fn();
    vi.mocked(useToast).mockReturnValue({
      toast: mockToast,
      dismiss: mockDismiss,
      toasts: [],
    });

    // Mock console.error to avoid test noise
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore mocks after each test
    vi.restoreAllMocks();
  });

  const setup = () => {
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
        title: FileExplorerStrings.error.title,
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
        title: FileExplorerStrings.error.title,
        description: error.message,
        variant: 'destructive',
      });
    });

    it('should handle generic errors', () => {
      const { result, mockToast } = setup();
      const error = new Error('Generic error');

      result.current.handleRefreshError(error);

      expect(mockToast).toHaveBeenCalledWith({
        title: FileExplorerStrings.error.title,
        description: FileExplorerStrings.error.refreshFailed,
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
        title: FileExplorerStrings.error.browserCompatibility,
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
        title: FileExplorerStrings.error.title,
        description: FileExplorerStrings.error.rootDirectoryFailed,
        variant: 'destructive',
      });
    });
  });

  describe('handleSelectionLimitError', () => {
    it('should show selection limit exceeded toast', () => {
      const { result, mockToast } = setup();

      result.current.handleSelectionLimitError();

      expect(mockToast).toHaveBeenCalledWith({
        title: FileExplorerStrings.error.title,
        description: FileExplorerStrings.error.selectionLimitExceeded,
        variant: 'destructive',
      });
    });
  });
});
