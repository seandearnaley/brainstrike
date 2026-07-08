import type { useToast } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import { useCallback } from 'react';

export interface DatabaseErrorBoundaryOptions {
  fallbackMessage?: string;
  onError?: (error: Error) => void;
  toast: ReturnType<typeof useToast>['toast'];
}

export type DatabaseOperation<T> = () => Promise<T>;

// Types for multiple operations
export interface DatabaseOperationItem<T = unknown> {
  critical?: boolean;
  name: string;
  operation: DatabaseOperation<T>;
}

export interface MultipleOperationsResult<T = unknown> {
  allSucceeded: boolean;
  failedCount: number;
  results: (T | null)[];
}

export interface ErrorCategories {
  isAuthError: boolean;
  isDatabaseNotReady: boolean;
  isNetworkError: boolean;
  isTransactionError: boolean;
  isValidationError: boolean;
}

export interface ClearOperationResult {
  deletedChunks: number;
  deletedFiles: number;
}

const logger = createLogger('useDatabaseErrorBoundary');
export const databaseErrorBoundaryLogger = logger;

export function useDatabaseErrorBoundary({
  toast,
  onError,
  fallbackMessage = 'An unexpected database error occurred',
}: DatabaseErrorBoundaryOptions) {
  // Helper function to categorize errors
  const categorizeError = useCallback(
    (errorMessage: string): ErrorCategories => ({
      isAuthError: errorMessage.includes('Unauthorized') || errorMessage.includes('permission'),
      isDatabaseNotReady: errorMessage.includes('Database repositories not available'),
      isNetworkError: errorMessage.includes('network') || errorMessage.includes('connection'),
      isTransactionError: errorMessage.includes('Transaction failed'),
      isValidationError: errorMessage.includes('Invalid') || errorMessage.includes('required'),
    }),
    []
  );

  // Helper function to get user-friendly error message
  const getUserFriendlyMessage = useCallback(
    (errorMessage: string): string => {
      const categories = categorizeError(errorMessage);

      if (categories.isNetworkError) {
        return 'Network connection failed. Please check your connection and try again.';
      }
      if (categories.isAuthError) {
        return 'You do not have permission to perform this operation.';
      }
      if (categories.isValidationError) {
        return 'Invalid input provided. Please check your data and try again.';
      }
      if (categories.isTransactionError) {
        return 'Database transaction failed. The operation was rolled back safely.';
      }
      if (categories.isDatabaseNotReady) {
        return 'Database is not ready. Please wait for initialization to complete.';
      }
      return errorMessage;
    },
    [categorizeError]
  );

  // Helper function to handle errors
  const handleError = useCallback(
    (error: unknown, errorTitle: string, operation: DatabaseOperation<unknown>) => {
      const errorMessage = error instanceof Error ? error.message : fallbackMessage;
      const userFriendlyMessage = getUserFriendlyMessage(errorMessage);

      toast({
        description: userFriendlyMessage,
        title: errorTitle,
        variant: 'destructive',
      });

      if (onError && error instanceof Error) {
        try {
          onError(error);
        } catch (handlerError) {
          logger.error('Error in custom database error handler', { error: handlerError });
        }
      }

      if (process.env['NODE_ENV'] === 'development') {
        logger.error('Database operation failed', {
          error,
          operation: operation.name || 'anonymous',
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    },
    [toast, onError, fallbackMessage, getUserFriendlyMessage]
  );

  const executeWithErrorBoundary = useCallback(
    async <T>(
      operation: DatabaseOperation<T>,
      options?: {
        successTitle?: string;
        successMessage?: string;
        errorTitle?: string;
        loadingTitle?: string;
        showSuccessToast?: boolean;
      }
    ): Promise<T | null> => {
      const {
        successTitle,
        successMessage,
        errorTitle = 'Operation Failed',
        showSuccessToast = false,
      } = options || {};

      try {
        const result = await operation();

        if (showSuccessToast && successTitle) {
          toast({
            description: successMessage,
            title: successTitle,
          });
        }

        return result;
      } catch (error) {
        handleError(error, errorTitle, operation as DatabaseOperation<unknown>);
        return null;
      }
    },
    [toast, handleError]
  );

  const executeWithLoadingState = useCallback(
    async <T>(
      operation: DatabaseOperation<T>,
      setLoading: (loading: boolean) => void,
      options?: Parameters<typeof executeWithErrorBoundary>[1]
    ): Promise<T | null> => {
      setLoading(true);
      try {
        return await executeWithErrorBoundary(operation, options);
      } finally {
        setLoading(false);
      }
    },
    [executeWithErrorBoundary]
  );

  // Helper function to check if result is a clear operation result
  const isClearOperationResult = useCallback(
    (result: unknown): result is ClearOperationResult =>
      Boolean(
        result &&
          typeof result === 'object' &&
          'deletedFiles' in result &&
          'deletedChunks' in result
      ),
    []
  );

  // Helper function to create description for clear operations
  const createClearOperationDescription = useCallback(
    (result: ClearOperationResult, suffix = '') =>
      `Deleted ${result.deletedFiles} files and ${result.deletedChunks} chunks${suffix}.`,
    []
  );

  // Helper function to handle critical operation failure
  const handleCriticalFailure = useCallback(
    (name: string, error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : fallbackMessage;
      toast({
        description: `${name} failed: ${errorMessage}. Remaining operations were cancelled.`,
        title: 'Critical Operation Failed',
        variant: 'destructive',
      });
    },
    [toast, fallbackMessage]
  );

  // Helper function to show success results
  const showSuccessResults = useCallback(
    (results: (unknown | null)[], options: { successTitle: string; successMessage?: string }) => {
      let description = options.successMessage;
      if (results[0] && isClearOperationResult(results[0])) {
        description = createClearOperationDescription(results[0], '. Data reloaded successfully');
      }
      toast({ description, title: options.successTitle });
    },
    [toast, isClearOperationResult, createClearOperationDescription]
  );

  // Helper function to show partial success results
  const showPartialSuccessResults = useCallback(
    ({
      results,
      operations,
      failedCount,
      options,
    }: {
      results: (unknown | null)[];
      operations: DatabaseOperationItem[];
      failedCount: number;
      options: { partialSuccessTitle: string; partialSuccessMessage?: string };
    }) => {
      let description =
        options.partialSuccessMessage ||
        `${operations.length - failedCount} operations succeeded, ${failedCount} failed`;
      if (results[0] && isClearOperationResult(results[0])) {
        description = createClearOperationDescription(
          results[0],
          ', but some data reload operations failed'
        );
      }
      toast({ description, title: options.partialSuccessTitle, variant: 'default' });
    },
    [toast, isClearOperationResult, createClearOperationDescription]
  );

  // Helper function to show failure results
  const showFailureResults = useCallback(() => {
    toast({
      description: 'None of the database operations completed successfully.',
      title: 'All Operations Failed',
      variant: 'destructive',
    });
  }, [toast]);

  // Helper function to show final results
  const showOperationResults = useCallback(
    ({
      results,
      allSucceeded,
      failedCount,
      operations,
      options,
    }: {
      results: (unknown | null)[];
      allSucceeded: boolean;
      failedCount: number;
      operations: DatabaseOperationItem[];
      options?: {
        successTitle?: string;
        successMessage?: string;
        partialSuccessTitle?: string;
        partialSuccessMessage?: string;
      };
    }) => {
      if (allSucceeded && options?.successTitle) {
        showSuccessResults(results, {
          successTitle: options.successTitle,
          ...(options.successMessage && { successMessage: options.successMessage }),
        });
        return;
      }

      if (!allSucceeded && failedCount < operations.length && options?.partialSuccessTitle) {
        showPartialSuccessResults({
          failedCount,
          operations,
          options: {
            partialSuccessTitle: options.partialSuccessTitle,
            ...(options.partialSuccessMessage && {
              partialSuccessMessage: options.partialSuccessMessage,
            }),
          },
          results,
        });
        return;
      }

      if (failedCount === operations.length) {
        showFailureResults();
      }
    },
    [showSuccessResults, showPartialSuccessResults, showFailureResults]
  );

  const executeMultipleOperations = useCallback(
    async <T = unknown>(
      operations: DatabaseOperationItem<T>[],
      setLoading: (loading: boolean) => void,
      options?: {
        successTitle?: string;
        successMessage?: string;
        partialSuccessTitle?: string;
        partialSuccessMessage?: string;
      }
    ): Promise<MultipleOperationsResult<T>> => {
      setLoading(true);
      const results: (T | null)[] = [];
      let failedCount = 0;

      try {
        for (const { operation, name, critical = false } of operations) {
          try {
            const result = await operation();
            results.push(result);
          } catch (error) {
            results.push(null);
            failedCount++;

            if (process.env['NODE_ENV'] === 'development') {
              logger.error('Database operation failed during batch execution', {
                error,
                operation: name,
              });
            }

            if (critical) {
              handleCriticalFailure(name, error);
              break;
            }
          }
        }

        const allSucceeded = failedCount === 0;
        showOperationResults({
          allSucceeded,
          failedCount,
          operations,
          results,
          ...(options && { options }),
        });

        return { allSucceeded, failedCount, results };
      } finally {
        setLoading(false);
      }
    },
    [handleCriticalFailure, showOperationResults]
  );

  return {
    executeMultipleOperations,
    executeWithErrorBoundary,
    executeWithLoadingState,
  };
}
