import { useVectorStatusUIStore } from '@brainstrike/app-state/stores/vector-status-ui-store';
import type { FileImportResult, ImportProgress } from '@brainstrike/db';
import { createLogger } from '@brainstrike/logging';
import type { IFileNode } from '@brainstrike/types';
import { getActiveEmbeddingSetId } from '@brainstrike/vector-management';
import { type Dispatch, type SetStateAction, useCallback, useMemo, useRef, useState } from 'react';
import { useFileImportService } from './base-file-import-service';
import type { EnhancedImportProgress, EnhancedImportResult } from './types';

const logger = createLogger('AppShell:EnhancedFileImport');

type BaseImportRunner = (request: {
  fileContents: Record<string, string>;
  fileTree: IFileNode[];
  onProgress: (progress: ImportProgress) => void;
  selectedFilePaths: Set<string>;
}) => Promise<FileImportResult[]>;

interface EnhancedFileImportOptions {
  onComplete?: (results: EnhancedImportResult[]) => Promise<void> | void;
  onError?: (error: Error) => void;
  onProgress?: (progress: EnhancedImportProgress) => void;
  resolveTargetEmbeddingSetId?: () => string | null;
}

interface EnhancedFileImportServiceReturn {
  cancelImport: () => void;
  importFiles: (
    selectedFilePaths: Set<string>,
    fileTree: IFileNode[],
    fileContents: Record<string, string>,
    abortSignal?: AbortSignal
  ) => Promise<void>;
  isImporting: boolean;
  progress: EnhancedImportProgress | null;
}

interface ImportFlowDeps {
  baseImportRunner: BaseImportRunner;
  controller: AbortController;
  fileContents: Record<string, string>;
  fileTree: IFileNode[];
  options: EnhancedFileImportOptions;
  selectedFilePaths: Set<string>;
  setProgress: Dispatch<SetStateAction<EnhancedImportProgress | null>>;
}

async function runNativeImportFlow({
  controller,
  baseImportRunner,
  fileContents,
  fileTree,
  selectedFilePaths,
  setProgress,
  options,
}: ImportFlowDeps): Promise<void> {
  if (controller.signal.aborted) {
    return;
  }
  const imported = await baseImportRunner({
    fileContents,
    fileTree,
    onProgress: (update) => {
      const progress = { ...update, phase: 'importing' as const };
      setProgress(progress);
      options.onProgress?.(progress);
    },
    selectedFilePaths,
  });
  if (controller.signal.aborted) {
    return;
  }
  const results = imported.map((item): EnhancedImportResult => {
    if (!('chunksCreated' in item) || typeof item.chunksCreated !== 'number') {
      throw new Error('Native import omitted its canonical chunk count.');
    }
    return { ...item, chunksCreated: item.chunksCreated };
  });
  const complete: EnhancedImportProgress = {
    completed: selectedFilePaths.size,
    errors: results.flatMap((item) => (item.error ? [{ error: item.error, file: item.id }] : [])),
    phase: 'complete',
    total: selectedFilePaths.size,
  };
  setProgress(complete);
  options.onProgress?.(complete);
  await options.onComplete?.(results);
}

function notifyImportFailure(
  error: unknown,
  signal: AbortSignal,
  onError: EnhancedFileImportOptions['onError']
): void {
  if (signal.aborted) {
    return;
  }
  onError?.(error instanceof Error ? error : new Error('Import failed'));
}

export function useEnhancedFileImportService(
  options: EnhancedFileImportOptions = {}
): EnhancedFileImportServiceReturn {
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState<EnhancedImportProgress | null>(null);
  const activeSetIdRef = useRef<string | null>(options.resolveTargetEmbeddingSetId?.() ?? null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const setGlobalIsImporting = useVectorStatusUIStore((s) => s.setIsImporting);
  const baseCallbacksRef = useRef<{
    onProgress?: (progress: ImportProgress) => void;
    onComplete?: (results: FileImportResult[]) => void;
    onError?: (error: Error) => void;
  } | null>(null);

  const baseImportService = useFileImportService({
    onComplete: (results) => {
      baseCallbacksRef.current?.onComplete?.(results);
    },
    onError: (error) => {
      baseCallbacksRef.current?.onError?.(error);
    },
    onProgress: (progress) => {
      baseCallbacksRef.current?.onProgress?.(progress);
    },
  });

  const baseImportRunner = useCallback<BaseImportRunner>(
    ({ selectedFilePaths, fileTree, fileContents, onProgress }) =>
      new Promise<FileImportResult[]>((resolve, reject) => {
        baseCallbacksRef.current = {
          onComplete: (results) => {
            baseCallbacksRef.current = null;
            resolve(results);
          },
          onError: (error) => {
            baseCallbacksRef.current = null;
            reject(error);
          },
          onProgress,
        };

        const activeSetId = activeSetIdRef.current ?? null;
        logger.debug('Passing embeddingSetId to baseImportService', { activeSetId });

        baseImportService
          .importFiles(selectedFilePaths, fileTree, fileContents, activeSetId ?? undefined)
          .catch((error) => {
            baseCallbacksRef.current = null;
            reject(error instanceof Error ? error : new Error('Import failed'));
          });
      }),
    [baseImportService]
  );

  const importFiles = useCallback(
    async (
      selectedFilePaths: Set<string>,
      fileTree: IFileNode[],
      fileContents: Record<string, string>,
      abortSignal?: AbortSignal
    ) => {
      // Create internal abort controller if none provided
      const controller = new AbortController();
      abortControllerRef.current = controller;

      // Link external signal if provided
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => controller.abort());
      }

      setIsImporting(true);
      setGlobalIsImporting(true); // Pause background token indexer during import

      activeSetIdRef.current = options.resolveTargetEmbeddingSetId?.() ?? getActiveEmbeddingSetId();

      const initialProgress: EnhancedImportProgress = {
        completed: 0,
        errors: [],
        phase: 'importing',
        total: selectedFilePaths.size,
      };

      setProgress(initialProgress);
      // Ensure UI can react immediately (e.g., show progress panel)
      options.onProgress?.(initialProgress);

      try {
        await runNativeImportFlow({
          baseImportRunner,
          controller,
          fileContents,
          fileTree,
          options,
          selectedFilePaths,
          setProgress,
        });
      } catch (error) {
        notifyImportFailure(error, controller.signal, options.onError);
      } finally {
        setIsImporting(false);
        setGlobalIsImporting(false); // Resume background token indexer
        abortControllerRef.current = null;
      }
    },
    [baseImportRunner, options, setGlobalIsImporting]
  );

  const cancelImport = useCallback(() => {
    if (abortControllerRef.current) {
      logger.info('Cancelling import');
      abortControllerRef.current.abort();
    }
  }, []);

  return useMemo(
    () => ({
      cancelImport,
      importFiles,
      isImporting,
      progress,
    }),
    [importFiles, isImporting, progress, cancelImport]
  );
}
