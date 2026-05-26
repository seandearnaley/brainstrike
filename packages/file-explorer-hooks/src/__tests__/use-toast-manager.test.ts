import { FileExplorerStrings, PartialRefreshError } from '@brainstrike/types';
import type { ToastActionElement } from '@brainstrike/ui';
import { useToast } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import { renderHook } from '@testing-library/react';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastManager } from '../use-toast-manager';

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
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
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
      toast: mockToast,
      dismiss: mockDismiss,
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
        title: 'Test Toast',
        description: 'This is a test toast',
        variant: 'default' as const,
      };

      result.current.showToast(toastParams);

      expect(mockToast).toHaveBeenCalledWith(toastParams);
    });

    it('calls toast with destructive variant', () => {
      const { result } = setup();
      const toastParams = {
        title: 'Error Toast',
        description: 'This is an error toast',
        variant: 'destructive' as const,
      };

      result.current.showToast(toastParams);

      expect(mockToast).toHaveBeenCalledWith(toastParams);
    });

    it('applies default variant when missing', () => {
      const { result } = setup();
      const mockAction = {} as ToastActionElement;
      const toastParams = {
        title: 'Action Toast',
        description: 'This is a toast with action',
        action: mockAction,
      };

      result.current.showToast(toastParams);

      expect(mockToast).toHaveBeenCalledWith({
        ...toastParams,
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
        title: FileExplorerStrings.error.title,
        description: 'Partial refresh failed',
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
        title: FileExplorerStrings.error.title,
        description: error.message,
        variant: 'destructive',
      });
    });

    it('handles generic errors', () => {
      const { result } = setup();
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
    it('shows toast with browser compatibility error', () => {
      const { result } = setup();
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
    it('logs error and shows toast', () => {
      const { result } = setup();
      const error = new Error('Failed to select directory');

      result.current.handleDirectorySelectError(error);

      expect(mockLogger.error).toHaveBeenCalledWith(
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

  describe('memoization', () => {
    it('uses latest toast implementation across callbacks after re-render', () => {
      const { result, rerender } = setup();
      const initialToast = mockToast;
      const nextToast = vi.fn();

      result.current.showToast({
        title: 'Initial',
        description: 'Initial render',
      });
      expect(initialToast).toHaveBeenCalledTimes(1);

      currentToastResult = {
        ...currentToastResult,
        toast: nextToast,
      };
      vi.mocked(useToast).mockImplementation(() => currentToastResult);
      rerender();

      result.current.showToast({
        title: 'Updated',
        description: 'After re-render',
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
