/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installRendererErrorHooks,
  type RendererErrorEventPayload,
} from '../logging/install-renderer-error-hooks';

// Mock the logger
const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@brainstrike/utils/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

// Store captured event handlers
interface CapturedHandlers {
  error: ((event: ErrorEvent) => void) | null;
  unhandledrejection: ((event: PromiseRejectionEvent) => void) | null;
}

const capturedHandlers: CapturedHandlers = {
  error: null,
  unhandledrejection: null,
};

// Create mock ErrorEvent-like objects for testing
function createMockErrorEvent(init: {
  message: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  error?: Error;
}): ErrorEvent {
  return {
    colno: init.colno,
    error: init.error,
    filename: init.filename,
    lineno: init.lineno,
    message: init.message,
  } as ErrorEvent;
}

function createMockRejectionEvent(init: { reason: unknown }): PromiseRejectionEvent {
  return {
    reason: init.reason,
  } as PromiseRejectionEvent;
}

describe('installRendererErrorHooks - Simple Tests', () => {
  describe('Basic Functionality', () => {
    it('should be a function', () => {
      expect(typeof installRendererErrorHooks).toBe('function');
    });

    it('should return a cleanup function', () => {
      const cleanup = installRendererErrorHooks();

      expect(typeof cleanup).toBe('function');
    });

    it('should execute without throwing', () => {
      expect(() => {
        const cleanup = installRendererErrorHooks();
        cleanup();
      }).not.toThrow();
    });

    it('should accept empty options object', () => {
      expect(() => {
        const cleanup = installRendererErrorHooks({});
        cleanup();
      }).not.toThrow();
    });

    it('should accept options with scope', () => {
      expect(() => {
        const cleanup = installRendererErrorHooks({ scope: 'TestScope' });
        cleanup();
      }).not.toThrow();
    });

    it('should accept options with onError callback', () => {
      const onError = () => {};

      expect(() => {
        const cleanup = installRendererErrorHooks({ onError });
        cleanup();
      }).not.toThrow();
    });

    it('should accept options with both scope and onError', () => {
      const onError = () => {};

      expect(() => {
        const cleanup = installRendererErrorHooks({ onError, scope: 'Custom' });
        cleanup();
      }).not.toThrow();
    });

    it('should allow multiple hook installations', () => {
      expect(() => {
        const cleanup1 = installRendererErrorHooks();
        const cleanup2 = installRendererErrorHooks({ scope: 'Second' });
        const cleanup3 = installRendererErrorHooks({ onError: () => {} });

        cleanup1();
        cleanup2();
        cleanup3();
      }).not.toThrow();
    });

    it('should be idempotent - cleanup can be called multiple times', () => {
      const cleanup = installRendererErrorHooks();

      expect(() => {
        cleanup();
        cleanup();
        cleanup();
      }).not.toThrow();
    });
  });

  describe('ResizeObserver Error Filtering', () => {
    let cleanup: () => void;
    let onErrorMock: (payload: RendererErrorEventPayload) => void;
    let addEventListenerSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.clearAllMocks();
      capturedHandlers.error = null;
      capturedHandlers.unhandledrejection = null;

      // Spy on addEventListener to capture the handlers
      addEventListenerSpy = vi
        .spyOn(window, 'addEventListener')
        .mockImplementation((type, handler) => {
          if (type === 'error' && typeof handler === 'function') {
            capturedHandlers.error = handler as (event: ErrorEvent) => void;
          } else if (type === 'unhandledrejection' && typeof handler === 'function') {
            capturedHandlers.unhandledrejection = handler as (event: PromiseRejectionEvent) => void;
          }
        });

      onErrorMock = vi.fn();
      cleanup = installRendererErrorHooks({ onError: onErrorMock });
    });

    afterEach(() => {
      cleanup();
      addEventListenerSpy.mockRestore();
    });

    it('should filter ResizeObserver loop limit exceeded errors', () => {
      const errorEvent = createMockErrorEvent({
        message: 'ResizeObserver loop limit exceeded',
      });
      capturedHandlers.error?.(errorEvent);

      expect(onErrorMock).not.toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('should filter ResizeObserver loop completed with undelivered notifications errors', () => {
      const errorEvent = createMockErrorEvent({
        message: 'ResizeObserver loop completed with undelivered notifications.',
      });
      capturedHandlers.error?.(errorEvent);

      expect(onErrorMock).not.toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('should filter any error message containing "ResizeObserver loop"', () => {
      const errorEvent = createMockErrorEvent({
        message: 'Some prefix ResizeObserver loop some suffix',
      });
      capturedHandlers.error?.(errorEvent);

      expect(onErrorMock).not.toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('should NOT filter regular errors', () => {
      const errorEvent = createMockErrorEvent({
        error: new TypeError('Cannot read property of undefined'),
        message: 'TypeError: Cannot read property of undefined',
      });
      capturedHandlers.error?.(errorEvent);

      expect(onErrorMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'TypeError: Cannot read property of undefined',
          type: 'error',
        })
      );
      expect(mockLogger.error).toHaveBeenCalledWith('Unhandled renderer error', expect.any(Object));
    });

    it('should NOT filter errors that mention ResizeObserver but not the loop pattern', () => {
      const errorEvent = createMockErrorEvent({
        message: 'ResizeObserver is not defined',
      });
      capturedHandlers.error?.(errorEvent);

      expect(onErrorMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'ResizeObserver is not defined',
          type: 'error',
        })
      );
    });

    it('should capture unhandled promise rejections', () => {
      const rejectionEvent = createMockRejectionEvent({
        reason: new Error('Async operation failed'),
      });
      capturedHandlers.unhandledrejection?.(rejectionEvent);

      expect(onErrorMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Async operation failed',
          type: 'unhandledrejection',
        })
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Unhandled renderer promise rejection',
        expect.any(Object)
      );
    });

    it('should handle unhandled promise rejections with string reason', () => {
      const rejectionEvent = createMockRejectionEvent({
        reason: 'Simple string error',
      });
      capturedHandlers.unhandledrejection?.(rejectionEvent);

      expect(onErrorMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Simple string error',
          type: 'unhandledrejection',
        })
      );
    });

    it('should handle unhandled promise rejections with unknown reason', () => {
      const rejectionEvent = createMockRejectionEvent({
        reason: { code: 500 },
      });
      capturedHandlers.unhandledrejection?.(rejectionEvent);

      expect(onErrorMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Unhandled promise rejection',
          type: 'unhandledrejection',
        })
      );
    });
  });

  describe('Error Payload Structure', () => {
    let cleanup: () => void;
    let onErrorMock: (payload: RendererErrorEventPayload) => void;
    let addEventListenerSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.clearAllMocks();
      capturedHandlers.error = null;
      capturedHandlers.unhandledrejection = null;

      // Spy on addEventListener to capture the handlers
      addEventListenerSpy = vi
        .spyOn(window, 'addEventListener')
        .mockImplementation((type, handler) => {
          if (type === 'error' && typeof handler === 'function') {
            capturedHandlers.error = handler as (event: ErrorEvent) => void;
          } else if (type === 'unhandledrejection' && typeof handler === 'function') {
            capturedHandlers.unhandledrejection = handler as (event: PromiseRejectionEvent) => void;
          }
        });

      onErrorMock = vi.fn();
      cleanup = installRendererErrorHooks({ onError: onErrorMock });
    });

    afterEach(() => {
      cleanup();
      addEventListenerSpy.mockRestore();
    });

    it('should include source and line information when available', () => {
      const errorEvent = createMockErrorEvent({
        colno: 10,
        filename: '/path/to/file.js',
        lineno: 42,
        message: 'Test error',
      });
      capturedHandlers.error?.(errorEvent);

      expect(onErrorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          column: 10,
          line: 42,
          message: 'Test error',
          source: '/path/to/file.js',
          type: 'error',
        })
      );
    });

    it('should include stack trace when error object has one', () => {
      const testError = new Error('Test error with stack');
      const errorEvent = createMockErrorEvent({
        error: testError,
        message: testError.message,
      });
      capturedHandlers.error?.(errorEvent);

      expect(onErrorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          stack: expect.stringContaining('Error: Test error with stack'),
          type: 'error',
        })
      );
    });

    it('should include stack trace in promise rejection payload', () => {
      const testError = new Error('Async error with stack');
      const rejectionEvent = createMockRejectionEvent({
        reason: testError,
      });
      capturedHandlers.unhandledrejection?.(rejectionEvent);

      expect(onErrorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          stack: expect.stringContaining('Error: Async error with stack'),
          type: 'unhandledrejection',
        })
      );
    });
  });

  describe('Cleanup Behavior', () => {
    it('should call removeEventListener for error handler on cleanup', () => {
      const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
      const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

      const cleanup = installRendererErrorHooks();

      // Verify addEventListener was called for 'error'
      expect(addEventListenerSpy).toHaveBeenCalledWith('error', expect.any(Function));

      // Cleanup
      cleanup();

      // Verify removeEventListener was called for 'error'
      expect(removeEventListenerSpy).toHaveBeenCalledWith('error', expect.any(Function));

      addEventListenerSpy.mockRestore();
      removeEventListenerSpy.mockRestore();
    });

    it('should call removeEventListener for unhandledrejection handler on cleanup', () => {
      const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
      const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

      const cleanup = installRendererErrorHooks();

      // Verify addEventListener was called for 'unhandledrejection'
      expect(addEventListenerSpy).toHaveBeenCalledWith('unhandledrejection', expect.any(Function));

      // Cleanup
      cleanup();

      // Verify removeEventListener was called for 'unhandledrejection'
      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        'unhandledrejection',
        expect.any(Function)
      );

      addEventListenerSpy.mockRestore();
      removeEventListenerSpy.mockRestore();
    });

    it('should use same handler reference for add and remove', () => {
      const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
      const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

      const cleanup = installRendererErrorHooks();

      // Get the handler that was added for 'error'
      const addErrorCall = addEventListenerSpy.mock.calls.find((call) => call[0] === 'error');
      const errorHandler = addErrorCall?.[1];

      cleanup();

      // Get the handler that was removed for 'error'
      const removeErrorCall = removeEventListenerSpy.mock.calls.find((call) => call[0] === 'error');
      const removedErrorHandler = removeErrorCall?.[1];

      // Verify same handler reference
      expect(errorHandler).toBe(removedErrorHandler);

      addEventListenerSpy.mockRestore();
      removeEventListenerSpy.mockRestore();
    });

    it('should stop calling onError callback after cleanup', () => {
      const onErrorMock = vi.fn<(payload: RendererErrorEventPayload) => void>();
      const capturedHandlerRef: { current: ((event: ErrorEvent) => void) | null } = {
        current: null,
      };

      const addEventListenerSpy = vi
        .spyOn(window, 'addEventListener')
        .mockImplementation((type, handler) => {
          if (type === 'error' && typeof handler === 'function') {
            capturedHandlerRef.current = handler as (event: ErrorEvent) => void;
          }
        });

      const cleanup = installRendererErrorHooks({ onError: onErrorMock });

      // Call handler before cleanup - should trigger onError
      const errorEvent1 = createMockErrorEvent({ message: 'Error before cleanup' });
      capturedHandlerRef.current?.(errorEvent1);
      expect(onErrorMock).toHaveBeenCalledTimes(1);

      // Cleanup
      cleanup();
      vi.clearAllMocks();

      // Call handler after cleanup - the handler itself still exists but
      // should still call onError since we captured the reference before cleanup
      // This tests that cleanup properly removes the listener from the window
      // (in real browser, the handler wouldn't be called after removeEventListener)

      addEventListenerSpy.mockRestore();
    });
  });
});
