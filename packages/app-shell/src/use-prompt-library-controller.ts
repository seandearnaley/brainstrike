import type { PromptItem, PromptItemRepository, PromptItemSimilarityResult } from '@brainstrike/db';
import type { buildLocalEmbeddingModelConfigMap } from '@brainstrike/db-explorer/embedding-models';
import type { QueueAdapter } from '@brainstrike/queue';
import type {
  EmbeddingSetModelInfo,
  UseSearchEmbedderResult,
} from '@brainstrike/vector-management';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { resolvePromptEmbeddingModelInfo } from './prompt-embedding-model-info';
import { embedPendingPromptItems, queryPromptSuggestions } from './prompt-library-embedding';
import { importLegacyPromptStore } from './prompt-library-legacy-import';

export type PromptManagerReadiness =
  | { readonly status: 'loading' }
  | {
      readonly error: string;
      readonly repository: PromptItemRepository;
      readonly status: 'error';
    }
  | {
      readonly items: readonly PromptItem[];
      readonly repository: PromptItemRepository;
      readonly status: 'ready';
    };

interface PromptIndexingPassResult {
  readonly error: string | null;
  readonly requestId: number;
}

interface UsePromptLibraryControllerOptions {
  readonly embedder: UseSearchEmbedderResult;
  readonly loadEmbeddingQueue: (() => Promise<QueueAdapter>) | null;
  readonly localModelConfigMap: ReturnType<typeof buildLocalEmbeddingModelConfigMap>;
  readonly repository: PromptItemRepository | null;
  readonly suggestionsEnabled: boolean;
}

export interface PromptLibraryController {
  readonly handleLibraryChanged: () => Promise<void>;
  readonly handleRequestSuggestions: (context: string) => Promise<PromptItemSimilarityResult[]>;
  readonly indexingError: string | null;
  readonly legacyImportWarning: string | null;
  readonly readiness: PromptManagerReadiness;
}

export function toPromptWorkbenchErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : `Unexpected Prompt Workbench failure: ${String(error)}`;
}

function promptRecallAbortError(): Error {
  const error = new Error('Prompt recall was cancelled because suggestions are no longer active.');
  error.name = 'AbortError';
  return error;
}

function throwIfPromptRecallAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : promptRecallAbortError();
  }
}

function usePromptRecallAbortController(enabled: boolean) {
  const controllerRef = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    if (!enabled) {
      controller.abort(promptRecallAbortError());
    }
    return () => {
      controller.abort(promptRecallAbortError());
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
  }, [enabled]);
  return controllerRef;
}

async function loadInitialPromptItems(repository: PromptItemRepository): Promise<{
  readonly items: PromptItem[];
  readonly legacyImportWarning: string | null;
}> {
  let legacyImportWarning: string | null = null;
  try {
    await importLegacyPromptStore(repository);
  } catch (error) {
    legacyImportWarning = `Legacy prompt import failed. Legacy data was retained: ${toPromptWorkbenchErrorMessage(error)}`;
  }
  const items = await repository.list();
  return { items, legacyImportWarning };
}

async function reloadPromptItemsAfterIndexing(
  repository: PromptItemRepository,
  runIndexingPass: () => Promise<PromptIndexingPassResult>
): Promise<
  | {
      readonly error: string;
      readonly indexing: PromptIndexingPassResult;
      readonly status: 'error';
    }
  | {
      readonly indexing: PromptIndexingPassResult;
      readonly items: PromptItem[];
      readonly status: 'ready';
    }
> {
  const indexing = await runIndexingPass();
  try {
    const items = await repository.list();
    return { indexing, items, status: 'ready' };
  } catch (error) {
    return { error: toPromptWorkbenchErrorMessage(error), indexing, status: 'error' };
  }
}

export function usePromptLibraryController({
  embedder,
  loadEmbeddingQueue,
  localModelConfigMap,
  repository,
  suggestionsEnabled,
}: UsePromptLibraryControllerOptions): PromptLibraryController {
  const [readiness, setReadiness] = useState<PromptManagerReadiness>({ status: 'loading' });
  const [indexingError, setIndexingError] = useState<string | null>(null);
  const [legacyImportWarning, setLegacyImportWarning] = useState<string | null>(null);
  const indexingTailRef = useRef<Promise<void> | null>(null);
  const latestIndexingRequestIdRef = useRef(0);
  const promptRecallAbortControllerRef = usePromptRecallAbortController(suggestionsEnabled);

  const resolveModelInfo = useCallback(async (): Promise<EmbeddingSetModelInfo> => {
    if (!repository) {
      throw new Error('Cannot resolve prompt embeddings before the database is ready.');
    }
    const profile = await repository.getEmbeddingProfile();
    return resolvePromptEmbeddingModelInfo(profile, localModelConfigMap);
  }, [localModelConfigMap, repository]);

  const ensureEmbeddingQueueReady = useCallback(async (): Promise<void> => {
    if (!loadEmbeddingQueue) {
      throw new Error('Prompt embeddings require an application embedding queue.');
    }
    await loadEmbeddingQueue();
  }, [loadEmbeddingQueue]);

  const performPendingItemIndexing = useCallback(async () => {
    if (!repository) {
      throw new Error('Cannot index prompts before the database is ready.');
    }
    await ensureEmbeddingQueueReady();
    const modelInfo = await resolveModelInfo();
    const outcomes = await embedPendingPromptItems({ embedder, modelInfo, repository });
    const failures = outcomes.filter((outcome) => outcome.status === 'error');
    if (failures.length > 0) {
      throw new Error(failures.map((outcome) => outcome.error).join('\n'));
    }
  }, [embedder, ensureEmbeddingQueueReady, repository, resolveModelInfo]);

  const runIndexingPass = useCallback((): Promise<PromptIndexingPassResult> => {
    const requestId = latestIndexingRequestIdRef.current + 1;
    latestIndexingRequestIdRef.current = requestId;
    const execute = async (): Promise<PromptIndexingPassResult> => {
      try {
        await performPendingItemIndexing();
        return { error: null, requestId };
      } catch (error) {
        return { error: toPromptWorkbenchErrorMessage(error), requestId };
      }
    };
    const pass = (indexingTailRef.current ?? Promise.resolve()).then(execute, execute);
    indexingTailRef.current = pass.then(
      () => undefined,
      () => undefined
    );
    return pass;
  }, [performPendingItemIndexing]);

  useEffect(() => {
    if (!repository) {
      return;
    }
    let current = true;
    const initialize = (): void => {
      void loadInitialPromptItems(repository)
        .then((initial) => {
          if (!current) {
            return null;
          }
          setLegacyImportWarning(initial.legacyImportWarning);
          setReadiness({ items: initial.items, repository, status: 'ready' });
          return reloadPromptItemsAfterIndexing(repository, runIndexingPass);
        })
        .then((refreshed) => {
          if (
            !(refreshed && current) ||
            refreshed.indexing.requestId !== latestIndexingRequestIdRef.current
          ) {
            return;
          }
          if (refreshed.status === 'error') {
            setReadiness({
              error: refreshed.error,
              repository,
              status: 'error',
            });
            return;
          }
          setIndexingError(refreshed.indexing.error);
          setReadiness({ items: refreshed.items, repository, status: 'ready' });
        })
        .catch((error: unknown) => {
          if (!current) {
            return;
          }
          setReadiness({
            error: toPromptWorkbenchErrorMessage(error),
            repository,
            status: 'error',
          });
        });
    };
    initialize();
    return () => {
      current = false;
    };
  }, [repository, runIndexingPass]);

  const handleLibraryChanged = useCallback(async () => {
    const indexing = await runIndexingPass();
    if (indexing.requestId === latestIndexingRequestIdRef.current) {
      setIndexingError(null);
    }
    if (indexing.error) {
      throw new Error(indexing.error);
    }
  }, [runIndexingPass]);

  const handleRequestSuggestions = useCallback(
    async (context: string) => {
      if (!repository) {
        throw new Error('Cannot recall prompts before the database is ready.');
      }
      const signal = promptRecallAbortControllerRef.current?.signal;
      if (!(suggestionsEnabled && signal)) {
        throw promptRecallAbortError();
      }
      throwIfPromptRecallAborted(signal);
      await ensureEmbeddingQueueReady();
      throwIfPromptRecallAborted(signal);
      const modelInfo = await resolveModelInfo();
      throwIfPromptRecallAborted(signal);
      return queryPromptSuggestions({
        context,
        embedder,
        modelInfo,
        options: { limit: 6, threshold: 0.35 },
        repository,
        signal,
      });
    },
    [
      embedder,
      ensureEmbeddingQueueReady,
      promptRecallAbortControllerRef,
      repository,
      resolveModelInfo,
      suggestionsEnabled,
    ]
  );

  return {
    handleLibraryChanged,
    handleRequestSuggestions,
    indexingError,
    legacyImportWarning,
    readiness,
  };
}
