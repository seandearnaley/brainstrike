import type { ContextExportOutcome } from '@brainstrike/hooks';
import { createLogger } from '@brainstrike/logging';
import { Button } from '@brainstrike/ui';
import { AlertCircle } from 'lucide-react';
import { type ReactElement, useCallback, useRef, useState } from 'react';
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
    storedFailure?.selectionSnapshot === selectedFilePaths ? storedFailure : null;
  const failure = visibleStoredFailure ? failureForDisplay(visibleStoredFailure) : null;

  const loadPreviewFileContents = useCallback(
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
      const selectionSnapshot = selectedFilePaths;
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

function describeContextExportFailure(
  failure: Extract<PreviewContentFailure, { kind: 'context-export' }>
): {
  readonly buttonLabel: string | null;
  readonly description: string;
  readonly title: string;
} {
  const title = failure.action === 'copy' ? 'Context copy failed' : 'Context download failed';
  if (failure.outcome.reason === 'root-unavailable') {
    return {
      buttonLabel: null,
      description: 'Choose a workspace folder before exporting context.',
      title,
    };
  }
  if (failure.outcome.reason === 'generation-failed') {
    return {
      buttonLabel: failure.action === 'copy' ? 'Retry context copy' : 'Retry context download',
      description: 'The selected context could not be prepared.',
      title,
    };
  }
  return {
    buttonLabel: failure.action === 'copy' ? 'Retry context copy' : 'Retry context download',
    description:
      failure.action === 'copy'
        ? 'The generated context could not be copied to the clipboard.'
        : 'The generated context could not be saved.',
    title,
  };
}

export function PreviewContentFailureAlert({
  failure,
  onRetry,
}: {
  readonly failure: PreviewContentFailure;
  readonly onRetry: () => void;
}): ReactElement {
  const content =
    failure.kind === 'preview-load'
      ? {
          buttonLabel: 'Retry preview content',
          description:
            failure.compositeKeys.length === 1
              ? '1 selected file could not be loaded.'
              : `${failure.compositeKeys.length} selected files could not be loaded.`,
          title: 'Preview content unavailable',
        }
      : describeContextExportFailure(failure);
  const titleId =
    failure.kind === 'preview-load' ? 'preview-content-error-title' : 'context-export-error-title';

  return (
    <div
      aria-labelledby={titleId}
      className="m-3 flex items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3"
      role="alert"
    >
      <AlertCircle aria-hidden="true" className="h-5 w-5 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-sm" id={titleId}>
          {content.title}
        </p>
        <p className="text-muted-foreground text-xs">{content.description}</p>
      </div>
      {content.buttonLabel ? (
        <Button onClick={onRetry} size="sm" type="button" variant="outline">
          {content.buttonLabel}
        </Button>
      ) : null}
    </div>
  );
}
