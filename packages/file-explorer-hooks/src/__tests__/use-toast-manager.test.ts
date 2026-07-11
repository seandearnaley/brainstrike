import { FileExplorerStrings, PartialRefreshError } from '@brainstrike/types';
import type { ToastActionElement } from '@brainstrike/ui';
import { useToast } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import { renderHook } from '@testing-library/react';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TOAST_DURATION_MS, useToastManager } from '../use-toast-manager';

// Logger mock type for test purposes - uses generic Mock for variadic logging functions
type LogFn = Mock<(...args: unknown[]) => void>;
interface MockLogger {
  debug: LogFn;
  error: LogFn;
  fatal: LogFn;
  info: LogFn;
  trace: LogFn;
  warn: LogFn;
}

// Toast result mock type for test purposes
interface MockToastResult {
  dismiss: Mock<(toastId?: string) => void>;
  toast: Mock<
    (props: Record<string, unknown>) => {
      id: string;
      dismiss: () => void;
      update: (props: Record<string, unknown>) => void;
    }
  >;
  toasts: [];
}

const mockLogger = vi.hoisted<MockLogger>(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  info: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@brainstrike/ui', () => ({
  useToast: vi.fn(),
}));

vi.mock('@brainstrike/utils/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

const createLoggerMock = vi.mocked(createLogger);

describe('useToastManager', () => {
  let mockToast: MockToastResult['toast'];
  let mockDismiss: MockToastResult['dismiss'];
  let currentToastResult: MockToastResult;

  beforeEach(() => {
    vi.mocked(useToast).mockReset();

    mockToast = vi.fn();
    mockDismiss = vi.fn();
    currentToastResult = {
      dismiss: mockDismiss,
      toast: mockToast,
      toasts: [],
    };

    mockLogger.error.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.info.mockReset();
    mockLogger.debug.mockReset();

    createLoggerMock.mockReturnValue(mockLogger);

    vi.mocked(useToast).mockImplementation(() => currentToastResult);
  });

  afterEach(() => {
    vi.mocked(useToast).mockReset();
  });

  const setup = () => renderHook(() => useToastManager());

  describe('showToast', () => {
    it('calls toast with provided parameters', () => {
      const { result } = setup();
      const toastParams = {
        description: 'This is a test toast',
        title: 'Test Toast',
        variant: 'default' as const,
      };

      result.current.showToast(toastParams);

      expect(mockToast).toHaveBeenCalledWith({
        ...toastParams,
        duration: DEFAULT_TOAST_DURATION_MS,
      });
    });

    it('calls toast with destructive variant', () => {
      const { result } = setup();
      const toastParams = {
        description: 'This is an error toast',
        title: 'Error Toast',
        variant: 'destructive' as const,
      };

      result.current.showToast(toastParams);

      expect(mockToast).toHaveBeenCalledWith({
        ...toastParams,
        duration: DEFAULT_TOAST_DURATION_MS,
      });
    });

    it('applies default variant when missing', () => {
      const { result } = setup();
      const mockAction = {} as ToastActionElement;
      const toastParams = {
        action: mockAction,
        description: 'This is a toast with action',
        title: 'Action Toast',
      };

      result.current.showToast(toastParams);

      expect(mockToast).toHaveBeenCalledWith({
        ...toastParams,
        duration: DEFAULT_TOAST_DURATION_MS,
        variant: 'default',
      });
    });

    it('honors an explicit duration, including 0 for a sticky toast', () => {
      const { result } = setup();

      result.current.showToast({
        description: 'Long-running warning',
        duration: 0,
        title: 'Sticky',
      });
      expect(mockToast).toHaveBeenCalledWith({
        description: 'Long-running warning',
        duration: 0,
        title: 'Sticky',
        variant: 'default',
      });

      result.current.showToast({
        description: 'Quick note',
        duration: 2000,
        title: 'Fast',
      });
      expect(mockToast).toHaveBeenLastCalledWith({
        description: 'Quick note',
        duration: 2000,
        title: 'Fast',
        variant: 'default',
      });
    });
  });

  describe('handlePartialRefreshError', () => {
    it('shows destructive toast with error message', () => {
      const { result } = setup();
      const error = new PartialRefreshError('Partial refresh failed', 5, 3);

      result.current.handlePartialRefreshError(error);

      expect(mockToast).toHaveBeenCalledWith({
        description: 'Partial refresh failed',
        duration: DEFAULT_TOAST_DURATION_MS,
        title: FileExplorerStrings.error.title,
        variant: 'destructive',
      });
    });
  });

  describe('handleRefreshError', () => {
    it('handles PartialRefreshError', () => {
      const { result } = setup();
      const error = new PartialRefreshError('Partial refresh failed', 5, 3);

      result.current.handleRefreshError(error);

      expect(mockToast).toHaveBeenCalledWith({
        description: error.message,
        duration: DEFAULT_TOAST_DURATION_MS,
        title: FileExplorerStrings.error.title,
        variant: 'destructive',
      });
    });

    it('handles generic errors', () => {
      const { result } = setup();
      const error = new Error('Generic error');

      result.current.handleRefreshError(error);

      expect(mockToast).toHaveBeenCalledWith({
        description: FileExplorerStrings.error.refreshFailed,
        duration: DEFAULT_TOAST_DURATION_MS,
        title: FileExplorerStrings.error.title,
        variant: 'destructive',
      });
    });
  });

  describe('handleBrowserCompatibilityError', () => {
    it('shows toast with browser compatibility error', () => {
      const { result } = setup();
      const reason = 'Browser does not support FileSystem API';

      result.current.handleBrowserCompatibilityError(reason);

      expect(mockToast).toHaveBeenCalledWith({
        description: reason,
        duration: DEFAULT_TOAST_DURATION_MS,
        title: FileExplorerStrings.error.browserCompatibility,
        variant: 'destructive',
      });
    });
  });

  describe('handleDirectorySelectError', () => {
    it('logs error and shows toast', () => {
      const { result } = setup();
      const error = new Error('Failed to select directory');

      result.current.handleDirectorySelectError(error);

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to select root directory. Raw error:',
        error
      );
      expect(mockToast).toHaveBeenCalledWith({
        description: FileExplorerStrings.error.rootDirectoryFailed,
        duration: DEFAULT_TOAST_DURATION_MS,
        title: FileExplorerStrings.error.title,
        variant: 'destructive',
      });
    });
  });

  describe('memoization', () => {
    it('uses latest toast implementation across callbacks after re-render', () => {
      const { result, rerender } = setup();
      const initialToast = mockToast;
      const nextToast = vi.fn();

      result.current.showToast({
        description: 'Initial render',
        title: 'Initial',
      });
      expect(initialToast).toHaveBeenCalledTimes(1);

      currentToastResult = {
        ...currentToastResult,
        toast: nextToast,
      };
      vi.mocked(useToast).mockImplementation(() => currentToastResult);
      rerender();

      result.current.showToast({
        description: 'After re-render',
        title: 'Updated',
      });
      result.current.handlePartialRefreshError(new PartialRefreshError('Updated error', 2, 1));
      result.current.handleRefreshError(new Error('Generic'));
      result.current.handleBrowserCompatibilityError('Reason');
      result.current.handleDirectorySelectError(new Error('Select'));

      expect(nextToast).toHaveBeenCalledTimes(5);
      expect(initialToast).toHaveBeenCalledTimes(1);
    });
  });

  it('creates a logger with the ToastManager scope', () => {
    setup();
    expect(createLoggerMock).toHaveBeenCalledWith('ToastManager');
  });
});
