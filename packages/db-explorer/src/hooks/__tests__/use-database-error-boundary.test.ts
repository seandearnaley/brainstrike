import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  databaseErrorBoundaryLogger,
  useDatabaseErrorBoundary,
} from '../use-database-error-boundary';

describe('useDatabaseErrorBoundary', () => {
  const mockToast = vi.fn();
  const mockOnError = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('categorizeError', () => {
    it('should categorize network errors correctly', async () => {
      const { result } = renderHook(() => useDatabaseErrorBoundary({ toast: mockToast }));

      const { executeWithErrorBoundary } = result.current;

      const networkError = new Error('network connection failed');
      await act(async () => {
        await executeWithErrorBoundary(async () => {
          throw networkError;
        });
      });

      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Operation Failed',
          description: 'Network connection failed. Please check your connection and try again.',
          variant: 'destructive',
        })
      );
    });

    it('should categorize auth errors correctly', async () => {
      const { result } = renderHook(() => useDatabaseErrorBoundary({ toast: mockToast }));

      const authError = new Error('Unauthorized access');
      await act(async () => {
        await result.current.executeWithErrorBoundary(async () => {
          throw authError;
        });
      });

      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'You do not have permission to perform this operation.',
        })
      );
    });

    it('should categorize validation errors correctly', async () => {
      const { result } = renderHook(() => useDatabaseErrorBoundary({ toast: mockToast }));

      const validationError = new Error('Invalid input: field required');
      await act(async () => {
        await result.current.executeWithErrorBoundary(async () => {
          throw validationError;
        });
      });

      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Invalid input provided. Please check your data and try again.',
        })
      );
    });

    it('should categorize transaction errors correctly', async () => {
      const { result } = renderHook(() => useDatabaseErrorBoundary({ toast: mockToast }));

      const transactionError = new Error('Transaction failed');
      await act(async () => {
        await result.current.executeWithErrorBoundary(async () => {
          throw transactionError;
        });
      });

      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Database transaction failed. The operation was rolled back safely.',
        })
      );
    });

    it('should categorize database not ready errors correctly', async () => {
      const { result } = renderHook(() => useDatabaseErrorBoundary({ toast: mockToast }));

      const dbError = new Error('Database repositories not available');
      await act(async () => {
        await result.current.executeWithErrorBoundary(async () => {
          throw dbError;
        });
      });

      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Database is not ready. Please wait for initialization to complete.',
        })
      );
    });
  });

  describe('executeWithErrorBoundary', () => {
    it('should execute successful operations without showing toast', async () => {
      const { result } = renderHook(() => useDatabaseErrorBoundary({ toast: mockToast }));

      const successResult = { data: 'test' };
      const operation = vi.fn().mockResolvedValue(successResult);

      const response = await act(async () => {
        return await result.current.executeWithErrorBoundary(operation);
      });

      expect(response).toEqual(successResult);
      expect(mockToast).not.toHaveBeenCalled();
    });

    it('should show success toast when configured', async () => {
      const { result } = renderHook(() => useDatabaseErrorBoundary({ toast: mockToast }));

      const operation = vi.fn().mockResolvedValue({ success: true });

      await act(async () => {
        await result.current.executeWithErrorBoundary(operation, {
          successTitle: 'Success',
          successMessage: 'Operation completed',
          showSuccessToast: true,
        });
      });

      expect(mockToast).toHaveBeenCalledWith({
        title: 'Success',
        description: 'Operation completed',
      });
    });

    it('should handle custom error title', async () => {
      const { result } = renderHook(() => useDatabaseErrorBoundary({ toast: mockToast }));

      await act(async () => {
        await result.current.executeWithErrorBoundary(
          async () => {
            throw new Error('Test error');
          },
          { errorTitle: 'Custom Error Title' }
        );
      });

      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Custom Error Title',
        })
      );
    });

    it('should call custom error handler', async () => {
      const { result } = renderHook(() =>
        useDatabaseErrorBoundary({ toast: mockToast, onError: mockOnError })
      );

      const error = new Error('Test error');
      await act(async () => {
        await result.current.executeWithErrorBoundary(async () => {
          throw error;
        });
      });

      expect(mockOnError).toHaveBeenCalledWith(error);
    });

    it('should handle non-Error objects', async () => {
      const { result } = renderHook(() =>
        useDatabaseErrorBoundary({
          toast: mockToast,
          fallbackMessage: 'Custom fallback message',
        })
      );

      await act(async () => {
        await result.current.executeWithErrorBoundary(async () => {
          throw 'string error'; // eslint-disable-line no-throw-literal
        });
      });

      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Custom fallback message',
        })
      );
    });

    it('should handle error in custom error handler gracefully', async () => {
      const loggerErrorSpy = vi
        .spyOn(databaseErrorBoundaryLogger, 'error')
        .mockImplementation(() => {});
      const errorThrowingHandler = vi.fn().mockImplementation(() => {
        throw new Error('Handler error');
      });

      const { result } = renderHook(() =>
        useDatabaseErrorBoundary({ toast: mockToast, onError: errorThrowingHandler })
      );

      await act(async () => {
        await result.current.executeWithErrorBoundary(async () => {
          throw new Error('Original error');
        });
      });

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        'Error in custom database error handler',
        expect.objectContaining({
          error: expect.any(Error),
        })
      );
      expect(mockToast).toHaveBeenCalled();

      loggerErrorSpy.mockRestore();
    });
  });

  describe('executeWithLoadingState', () => {
    it('should set loading state during operation', async () => {
      const { result } = renderHook(() => useDatabaseErrorBoundary({ toast: mockToast }));

      const setLoading = vi.fn();
      vi.useFakeTimers();
      const operation = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ data: 'test' }), 100);
          })
      );

      await act(async () => {
        const p = result.current.executeWithLoadingState(operation, setLoading);
        expect(setLoading).toHaveBeenCalledWith(true);
        await vi.advanceTimersByTimeAsync(100);
        await p;
      });

      expect(setLoading).toHaveBeenCalledWith(false);
      expect(setLoading).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('should reset loading state even on error', async () => {
      const { result } = renderHook(() => useDatabaseErrorBoundary({ toast: mockToast }));

      const setLoading = vi.fn();
      const operation = vi.fn().mockRejectedValue(new Error('Test error'));

      await act(async () => {
        await result.current.executeWithLoadingState(operation, setLoading);
      });

      expect(setLoading).toHaveBeenCalledWith(true);
      expect(setLoading).toHaveBeenCalledWith(false);
      expect(setLoading).toHaveBeenCalledTimes(2);
    });
  });

  describe('executeMultipleOperations', () => {
    it('should execute all successful operations', async () => {
      const { result } = renderHook(() => useDatabaseErrorBoundary({ toast: mockToast }));

      const setLoading = vi.fn();
      const operations = [
        { operation: vi.fn().mockResolvedValue({ id: 1 }), name: 'Op1' },
        { operation: vi.fn().mockResolvedValue({ id: 2 }), name: 'Op2' },
        { operation: vi.fn().mockResolvedValue({ id: 3 }), name: 'Op3' },
      ];

      const response = await act(async () => {
        return await result.current.executeMultipleOperations(operations, setLoading, {
          successTitle: 'All Done',
          successMessage: 'All operations completed',
        });
      });

      expect(response).toEqual({
        results: [{ id: 1 }, { id: 2 }, { id: 3 }],
        allSucceeded: true,
        failedCount: 0,
      });
      expect(mockToast).toHaveBeenCalledWith({
        title: 'All Done',
        description: 'All operations completed',
      });
    });

    it('should handle partial failures', async () => {
      const { result } = renderHook(() => useDatabaseErrorBoundary({ toast: mockToast }));

      const setLoading = vi.fn();
      const operations = [
        { operation: vi.fn().mockResolvedValue({ id: 1 }), name: 'Op1' },
        { operation: vi.fn().mockRejectedValue(new Error('Failed')), name: 'Op2' },
        { operation: vi.fn().mockResolvedValue({ id: 3 }), name: 'Op3' },
      ];

      const response = await act(async () => {
        return await result.current.executeMultipleOperations(operations, setLoading, {
          partialSuccessTitle: 'Partial Success',
          partialSuccessMessage: 'Some operations completed',
        });
      });

      expect(response).toEqual({
        results: [{ id: 1 }, null, { id: 3 }],
        allSucceeded: false,
        failedCount: 1,
      });
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Partial Success',
        description: 'Some operations completed',
        variant: 'default',
      });
    });

    it('should stop on critical failure', async () => {
      const { result } = renderHook(() => useDatabaseErrorBoundary({ toast: mockToast }));

      const setLoading = vi.fn();
      const op3 = vi.fn().mockResolvedValue({ id: 3 });
      const operations = [
        { operation: vi.fn().mockResolvedValue({ id: 1 }), name: 'Op1' },
        {
          operation: vi.fn().mockRejectedValue(new Error('Critical failure')),
          name: 'Op2',
          critical: true,
        },
        { operation: op3, name: 'Op3' },
      ];

      const response = await act(async () => {
        return await result.current.executeMultipleOperations(operations, setLoading);
      });

      expect(response.failedCount).toBe(1);
      expect(response.results).toHaveLength(2); // Op3 not executed
      expect(op3).not.toHaveBeenCalled();
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Critical Operation Failed',
          description: expect.stringContaining('Op2 failed: Critical failure'),
        })
      );
    });

    it('should handle all operations failing', async () => {
      const { result } = renderHook(() => useDatabaseErrorBoundary({ toast: mockToast }));

      const setLoading = vi.fn();
      const operations = [
        { operation: vi.fn().mockRejectedValue(new Error('Failed 1')), name: 'Op1' },
        { operation: vi.fn().mockRejectedValue(new Error('Failed 2')), name: 'Op2' },
      ];

      const response = await act(async () => {
        return await result.current.executeMultipleOperations(operations, setLoading);
      });

      expect(response.allSucceeded).toBe(false);
      expect(response.failedCount).toBe(2);
      expect(mockToast).toHaveBeenCalledWith({
        title: 'All Operations Failed',
        description: 'None of the database operations completed successfully.',
        variant: 'destructive',
      });
    });

    it('should handle clear operation results specially', async () => {
      const { result } = renderHook(() => useDatabaseErrorBoundary({ toast: mockToast }));

      const setLoading = vi.fn();
      const clearResult = { deletedFiles: 10, deletedChunks: 50 };
      const operations = [
        { operation: vi.fn().mockResolvedValue(clearResult), name: 'Clear DB' },
        { operation: vi.fn().mockResolvedValue({ success: true }), name: 'Reload' },
      ];

      await act(async () => {
        await result.current.executeMultipleOperations(operations, setLoading, {
          successTitle: 'Database Cleared',
        });
      });

      expect(mockToast).toHaveBeenCalledWith({
        title: 'Database Cleared',
        description: 'Deleted 10 files and 50 chunks. Data reloaded successfully.',
      });
    });

    it('should handle clear operation with partial failure', async () => {
      const { result } = renderHook(() => useDatabaseErrorBoundary({ toast: mockToast }));

      const setLoading = vi.fn();
      const clearResult = { deletedFiles: 5, deletedChunks: 20 };
      const operations = [
        { operation: vi.fn().mockResolvedValue(clearResult), name: 'Clear DB' },
        { operation: vi.fn().mockRejectedValue(new Error('Reload failed')), name: 'Reload' },
      ];

      await act(async () => {
        await result.current.executeMultipleOperations(operations, setLoading, {
          partialSuccessTitle: 'Partial Success',
        });
      });

      expect(mockToast).toHaveBeenCalledWith({
        title: 'Partial Success',
        description: 'Deleted 5 files and 20 chunks, but some data reload operations failed.',
        variant: 'default',
      });
    });
  });

  describe('helper functions coverage', () => {
    it('should handle permission errors', async () => {
      const { result } = renderHook(() => useDatabaseErrorBoundary({ toast: mockToast }));

      await act(async () => {
        await result.current.executeWithErrorBoundary(async () => {
          throw new Error('permission denied');
        });
      });

      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'You do not have permission to perform this operation.',
        })
      );
    });

    it('should handle connection errors', async () => {
      const { result } = renderHook(() => useDatabaseErrorBoundary({ toast: mockToast }));

      await act(async () => {
        await result.current.executeWithErrorBoundary(async () => {
          throw new Error('connection timeout');
        });
      });

      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Network connection failed. Please check your connection and try again.',
        })
      );
    });

    it('should log errors in development', async () => {
      const originalEnv = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'development';
      const loggerErrorSpy = vi
        .spyOn(databaseErrorBoundaryLogger, 'error')
        .mockImplementation(() => {});

      const { result } = renderHook(() => useDatabaseErrorBoundary({ toast: mockToast }));

      const error = new Error('Test error');
      await act(async () => {
        await result.current.executeWithErrorBoundary(async () => {
          throw error;
        });
      });

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        'Database operation failed',
        expect.objectContaining({
          operation: 'anonymous',
          error,
          stack: expect.any(String),
        })
      );

      process.env['NODE_ENV'] = originalEnv;
      loggerErrorSpy.mockRestore();
    });

    it('should not log errors in production', async () => {
      const originalEnv = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'production';
      const loggerErrorSpy = vi
        .spyOn(databaseErrorBoundaryLogger, 'error')
        .mockImplementation(() => {});

      const { result } = renderHook(() => useDatabaseErrorBoundary({ toast: mockToast }));

      await act(async () => {
        await result.current.executeWithErrorBoundary(async () => {
          throw new Error('Test error');
        });
      });

      expect(loggerErrorSpy).not.toHaveBeenCalled();

      process.env['NODE_ENV'] = originalEnv;
      loggerErrorSpy.mockRestore();
    });
  });
});
