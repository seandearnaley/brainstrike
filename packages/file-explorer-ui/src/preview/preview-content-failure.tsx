import type { ContextExportOutcome } from '@brainstrike/hooks';
import { createLogger } from '@brainstrike/logging';
import { useCallback, useRef, useState } from 'react';
import type { ContextExportOptions } from '../context-export-options';

const logger = createLogger('PreviewContentFailure');

type ContextExportAction = 'copy' | 'download';
type FailedContextExportOutcome = Exclude<ContextExportOutcome, { readonly ok: true }>;

interface StoredPreviewLoadFailure {
  readonly compositeKeys: readonly string[];
  readonly kind: 'preview-load';
  readonly selectionSnapshot: ReadonlySet<string>;
}

interface StoredContextExportFailure {
  readonly action: ContextExportAction;
  readonly kind: 'context-export';
  readonly options: ContextExportOptions;
  readonly outcome: FailedContextExportOutcome;
  readonly selectionSnapshot: ReadonlySet<string>;
}

type StoredPreviewFailure = StoredContextExportFailure | StoredPreviewLoadFailure;

export type PreviewContentFailure =
  | Pick<StoredPreviewLoadFailure, 'compositeKeys' | 'kind'>
  | Pick<StoredContextExportFailure, 'action' | 'kind' | 'outcome'>;

function snapshotContextExportOptions(options: ContextExportOptions): ContextExportOptions {
  return {
    projectTreeUsesViewFilters: options.projectTreeUsesViewFilters,
    selectedLineRangesByFile: Object.fromEntries(
      Object.entries(options.selectedLineRangesByFile).map(([compositeKey, ranges]) => [
        compositeKey,
        ranges.map((range) => ({ ...range })),
      ])
    ),
  };
}

function failureForDisplay(failure: StoredPreviewFailure): PreviewContentFailure {
  if (failure.kind === 'preview-load') {
    return { compositeKeys: failure.compositeKeys, kind: failure.kind };
  }
  return { action: failure.action, kind: failure.kind, outcome: failure.outcome };
}

function haveSameSelection(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const path of left) {
    if (!right.has(path)) {
      return false;
    }
  }
  return true;
}

export function usePreviewContentFailure({
  handleCopyContext,
  handleDownloadContext,
  loadMultipleFileContents,
  selectedFilePaths,
}: {
  readonly handleCopyContext: (options: ContextExportOptions) => Promise<ContextExportOutcome>;
  readonly handleDownloadContext: (options: ContextExportOptions) => Promise<ContextExportOutcome>;
  readonly loadMultipleFileContents: (compositeKeys: string[]) => Promise<void>;
  readonly selectedFilePaths: ReadonlySet<string>;
}): {
  readonly failure: PreviewContentFailure | null;
  readonly invalidate: () => void;
  readonly loadPreviewFileContents: (compositeKeys: string[]) => Promise<void>;
  readonly retry: () => void;
  readonly runContextExport: (action: ContextExportAction, options: ContextExportOptions) => void;
} {
  const [storedFailure, setStoredFailure] = useState<StoredPreviewFailure | null>(null);
  const requestIdRef = useRef(0);
  const visibleStoredFailure =
    storedFailure && haveSameSelection(storedFailure.selectionSnapshot, selectedFilePaths)
      ? storedFailure
      : null;
  const failure = visibleStoredFailure ? failureForDisplay(visibleStoredFailure) : null;

  const loadPreviewFileContents = useCallback(
    async (compositeKeys: string[]): Promise<void> => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      const selectionSnapshot = new Set(selectedFilePaths);
      const uniqueKeys = [...new Set(compositeKeys)];
      setStoredFailure(null);
      try {
        await loadMultipleFileContents(uniqueKeys);
      } catch (error) {
        if (requestIdRef.current === requestId) {
          setStoredFailure({
            compositeKeys: uniqueKeys,
            kind: 'preview-load',
            selectionSnapshot,
          });
        }
        throw error;
      }
    },
    [loadMultipleFileContents, selectedFilePaths]
  );

  const runContextExport = useCallback(
    (action: ContextExportAction, options: ContextExportOptions): void => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      const selectionSnapshot = new Set(selectedFilePaths);
      const optionsSnapshot = snapshotContextExportOptions(options);
      const execute = action === 'copy' ? handleCopyContext : handleDownloadContext;
      setStoredFailure(null);
      void execute(optionsSnapshot)
        .then((outcome) => {
          if (requestIdRef.current !== requestId) {
            return;
          }
          if (outcome.ok) {
            setStoredFailure(null);
            return;
          }
          setStoredFailure({
            action,
            kind: 'context-export',
            options: optionsSnapshot,
            outcome,
            selectionSnapshot,
          });
        })
        .catch((error: unknown) => {
          if (requestIdRef.current === requestId) {
            setStoredFailure({
              action,
              kind: 'context-export',
              options: optionsSnapshot,
              outcome: { ok: false, reason: 'action-failed', retryable: true },
              selectionSnapshot,
            });
          }
          logger.error('Context export rejected outside its typed outcome contract', {
            action,
            errorName: error instanceof Error ? error.name : 'UnknownError',
          });
        });
    },
    [handleCopyContext, handleDownloadContext, selectedFilePaths]
  );

  const invalidate = useCallback((): void => {
    requestIdRef.current += 1;
    setStoredFailure(null);
  }, []);

  const retry = useCallback((): void => {
    if (!visibleStoredFailure) {
      return;
    }
    if (visibleStoredFailure.kind === 'preview-load') {
      void loadPreviewFileContents([...visibleStoredFailure.compositeKeys]).catch(
        (error: unknown) => {
          logger.error('Preview file-content retry failed', {
            errorName: error instanceof Error ? error.name : 'UnknownError',
            fileCount: visibleStoredFailure.compositeKeys.length,
          });
        }
      );
      return;
    }
    if (!visibleStoredFailure.outcome.retryable) {
      return;
    }
    runContextExport(visibleStoredFailure.action, visibleStoredFailure.options);
  }, [loadPreviewFileContents, runContextExport, visibleStoredFailure]);

  return {
    failure,
    invalidate,
    loadPreviewFileContents,
    retry,
    runContextExport,
  };
}
