import { createLogger } from '@brainstrike/logging';
import { Button } from '@brainstrike/ui';
import { AlertCircle } from 'lucide-react';
import { type ReactElement, useCallback, useRef, useState } from 'react';

const logger = createLogger('PreviewContentFailure');

interface StoredPreviewContentFailure {
  readonly compositeKeys: readonly string[];
  readonly selectionSnapshot: ReadonlySet<string>;
}

export interface PreviewContentFailure {
  readonly compositeKeys: readonly string[];
}

export function usePreviewContentFailure({
  loadMultipleFileContents,
  selectedFilePaths,
}: {
  readonly loadMultipleFileContents: (compositeKeys: string[]) => Promise<void>;
  readonly selectedFilePaths: ReadonlySet<string>;
}): {
  readonly failure: PreviewContentFailure | null;
  readonly invalidate: () => void;
  readonly loadFileContents: (compositeKeys: string[]) => Promise<void>;
  readonly retry: () => void;
  readonly runSelectionOperation: (operation: () => Promise<void>, logMessage: string) => void;
} {
  const [storedFailure, setStoredFailure] = useState<StoredPreviewContentFailure | null>(null);
  const requestIdRef = useRef(0);
  const failure = storedFailure?.selectionSnapshot === selectedFilePaths ? storedFailure : null;

  const loadFileContents = useCallback(
    async (compositeKeys: string[]): Promise<void> => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      const selectionSnapshot = selectedFilePaths;
      const uniqueKeys = [...new Set(compositeKeys)];
      setStoredFailure(null);
      try {
        await loadMultipleFileContents(uniqueKeys);
      } catch (error) {
        if (requestIdRef.current === requestId) {
          setStoredFailure({ compositeKeys: uniqueKeys, selectionSnapshot });
        }
        throw error;
      }
    },
    [loadMultipleFileContents, selectedFilePaths]
  );

  const runSelectionOperation = useCallback(
    (operation: () => Promise<void>, logMessage: string): void => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      const selectionSnapshot = selectedFilePaths;
      setStoredFailure(null);
      void operation().catch((error: unknown) => {
        if (requestIdRef.current === requestId) {
          setStoredFailure({
            compositeKeys: [...selectionSnapshot],
            selectionSnapshot,
          });
        }
        logger.error(logMessage, {
          errorName: error instanceof Error ? error.name : 'UnknownError',
          fileCount: selectionSnapshot.size,
        });
      });
    },
    [selectedFilePaths]
  );

  const invalidate = useCallback((): void => {
    requestIdRef.current += 1;
    setStoredFailure(null);
  }, []);

  const retry = useCallback((): void => {
    if (!failure) {
      return;
    }
    void loadFileContents([...failure.compositeKeys]).catch((error: unknown) => {
      logger.error('Preview file-content retry failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
        fileCount: failure.compositeKeys.length,
      });
    });
  }, [failure, loadFileContents]);

  return {
    failure,
    invalidate,
    loadFileContents,
    retry,
    runSelectionOperation,
  };
}

export function PreviewContentFailureAlert({
  failure,
  onRetry,
}: {
  readonly failure: PreviewContentFailure;
  readonly onRetry: () => void;
}): ReactElement {
  return (
    <div
      aria-labelledby="preview-content-error-title"
      className="m-3 flex items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3"
      role="alert"
    >
      <AlertCircle aria-hidden="true" className="h-5 w-5 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-sm" id="preview-content-error-title">
          Preview content unavailable
        </p>
        <p className="text-muted-foreground text-xs">
          {failure.compositeKeys.length === 1
            ? '1 selected file could not be loaded.'
            : `${failure.compositeKeys.length} selected files could not be loaded.`}
        </p>
      </div>
      <Button onClick={onRetry} size="sm" type="button" variant="outline">
        Retry preview content
      </Button>
    </div>
  );
}
