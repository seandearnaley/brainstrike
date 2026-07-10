import {
  type PromptItem,
  PromptItemRepository,
  type PromptItemUsageAction,
  usePGliteDatabase,
} from '@brainstrike/db';
import { buildLocalEmbeddingModelConfigMap } from '@brainstrike/db-explorer/embedding-models';
import { useEnsureModelRegistry } from '@brainstrike/preferences/hooks/use-model-registry';
import { useAssistantPreferencesStore } from '@brainstrike/preferences/stores/assistant-preferences-store';
import { useModelRegistryStore } from '@brainstrike/preferences/stores/model-registry-store';
import type { QueueAdapter } from '@brainstrike/queue';
import type { EmbeddingSetModelInfo } from '@brainstrike/vector-management';
import { useSharedSearchEmbedder } from '@brainstrike/vector-management';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAssistantComposerCommandStore } from './assistant-composer-command-store';
import { createPgliteAssistantThreadRepository } from './assistant-memory-repository';
import { WORKSPACE_MEMORY_RESOURCE_ID } from './assistant-memory-resource';
import { useAssistantThreadStore } from './assistant-thread-store';
import { resolvePromptEmbeddingModelInfo } from './prompt-embedding-model-info';
import { embedPendingPromptItems, queryPromptSuggestions } from './prompt-library-embedding';
import { importLegacyPromptStore } from './prompt-library-legacy-import';
import { type PromptWorkbenchModelOption, PromptWorkbenchPanel } from './prompt-workbench-panel';

type PromptManagerReadiness =
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

function toErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : `Unexpected Prompt Workbench failure: ${String(error)}`;
}

function parseCompositeModelKey(modelKey: string): { model: string; provider: string } {
  const separator = modelKey.indexOf('::');
  if (separator <= 0 || separator !== modelKey.lastIndexOf('::')) {
    throw new Error(`Prompt item has an invalid model key: ${modelKey}`);
  }
  const provider = modelKey.slice(0, separator).trim();
  const model = modelKey.slice(separator + 2).trim();
  if (!(provider && model)) {
    throw new Error(`Prompt item has an invalid model key: ${modelKey}`);
  }
  return { model, provider };
}

async function resolveRequestedPromptRuntime({
  action,
  getAvailableProviders,
  item,
  modelOptions,
}: {
  readonly action: PromptItemUsageAction;
  readonly getAvailableProviders: () => Promise<readonly string[]>;
  readonly item: PromptItem;
  readonly modelOptions: readonly PromptWorkbenchModelOption[];
}): Promise<{ model: string; provider: string } | null> {
  if (!((action === 'compose' || action === 'new-thread') && item.modelKey)) {
    return null;
  }
  if (!modelOptions.some((option) => option.key === item.modelKey)) {
    throw new Error(
      `Prompt "${item.title}" requests model "${item.modelKey}", but that model is not enabled.`
    );
  }
  const requestedRuntime = parseCompositeModelKey(item.modelKey);
  const availableProviders = await getAvailableProviders();
  if (!availableProviders.some((provider) => provider === requestedRuntime.provider)) {
    throw new Error(
      `Prompt "${item.title}" requests ${requestedRuntime.provider}, but that provider is not available.`
    );
  }
  return requestedRuntime;
}

interface ConnectedPromptManagerProps {
  readonly loadEmbeddingQueue: (() => Promise<QueueAdapter>) | null;
}

interface PromptIndexingPassResult {
  readonly error: string | null;
  readonly requestId: number;
}

async function loadInitialPromptItems(repository: PromptItemRepository): Promise<PromptItem[]> {
  await importLegacyPromptStore(repository);
  return repository.list();
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
    return { error: toErrorMessage(error), indexing, status: 'error' };
  }
}

export function ConnectedPromptManager({ loadEmbeddingQueue }: ConnectedPromptManagerProps) {
  const db = usePGliteDatabase();
  useEnsureModelRegistry({ db });
  const models = useModelRegistryStore((state) => state.models);
  const providers = useModelRegistryStore((state) => state.providers);
  const getAvailableProviders = useAssistantPreferencesStore(
    (state) => state.getAvailableProviders
  );
  const embedder = useSharedSearchEmbedder();
  const activeThreadId = useAssistantThreadStore(
    (state) => state.activeThreadIdByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
  );
  const createThread = useAssistantThreadStore((state) => state.createThread);
  const setThreadDraftRuntime = useAssistantThreadStore((state) => state.setThreadDraftRuntime);
  const composerContext = useAssistantComposerCommandStore((state) =>
    activeThreadId ? (state.draftTextByThreadId[activeThreadId] ?? '') : ''
  );
  const enqueueComposerCommand = useAssistantComposerCommandStore((state) => state.enqueue);
  const [readiness, setReadiness] = useState<PromptManagerReadiness>({ status: 'loading' });
  const [indexingError, setIndexingError] = useState<string | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const indexingTailRef = useRef<Promise<void> | null>(null);
  const latestIndexingRequestIdRef = useRef(0);

  const repository = useMemo(() => (db ? new PromptItemRepository(db) : null), [db]);
  const threadRepository = useMemo(
    () => (db ? createPgliteAssistantThreadRepository(db) : null),
    [db]
  );
  const localModelConfigMap = useMemo(() => buildLocalEmbeddingModelConfigMap(models), [models]);
  const providerNames = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider.name])),
    [providers]
  );
  const enabledProviderIds = useMemo(() => {
    const ids = new Set<string>();
    for (const provider of providers) {
      if (provider.isEnabled) {
        ids.add(provider.id);
      }
    }
    return ids;
  }, [providers]);
  const modelOptions = useMemo<PromptWorkbenchModelOption[]>(() => {
    const options: PromptWorkbenchModelOption[] = [];
    for (const model of models) {
      if (
        model.isEnabled &&
        model.capabilities.type === 'llm' &&
        enabledProviderIds.has(model.providerId)
      ) {
        options.push({
          key: `${model.providerId}::${model.id}`,
          label: `${providerNames.get(model.providerId) ?? model.providerId} · ${model.name}`,
        });
      }
    }
    return options;
  }, [enabledProviderIds, models, providerNames]);

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
        return { error: toErrorMessage(error), requestId };
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
        .then((items) => {
          if (!current) {
            return null;
          }
          setReadiness({ items, repository, status: 'ready' });
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
            error: toErrorMessage(error),
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
      await ensureEmbeddingQueueReady();
      const modelInfo = await resolveModelInfo();
      return queryPromptSuggestions({
        context,
        embedder,
        modelInfo,
        options: { limit: 6, threshold: 0.35 },
        repository,
      });
    },
    [embedder, ensureEmbeddingQueueReady, repository, resolveModelInfo]
  );

  const recordAppliedUsage = useCallback(
    async (itemId: string, action: PromptItemUsageAction): Promise<void> => {
      if (!repository) {
        throw new Error('Cannot record prompt usage before the database is ready.');
      }
      try {
        await repository.recordUsage(itemId, action);
        setUsageError(null);
      } catch (error) {
        setUsageError(`Prompt was staged, but usage tracking failed: ${toErrorMessage(error)}`);
      }
    },
    [repository]
  );

  const handleUseItem = useCallback(
    async (item: PromptItem, renderedContent: string, action: PromptItemUsageAction) => {
      if (!(repository && threadRepository)) {
        throw new Error('Cannot use a prompt before the database is ready.');
      }

      const requestedRuntime = await resolveRequestedPromptRuntime({
        action,
        getAvailableProviders,
        item,
        modelOptions,
      });

      if (action === 'new-thread') {
        const thread = await createThread(
          threadRepository,
          WORKSPACE_MEMORY_RESOURCE_ID,
          item.title
        );
        if (requestedRuntime) {
          setThreadDraftRuntime(thread.id, requestedRuntime);
        }
        enqueueComposerCommand({
          mode: 'replace',
          text: renderedContent,
          threadId: thread.id,
        });
        await recordAppliedUsage(item.id, action);
        return;
      }

      if (!activeThreadId) {
        throw new Error('Open an assistant thread before adding a prompt to the composer.');
      }
      if (action === 'compose' && requestedRuntime) {
        setThreadDraftRuntime(activeThreadId, requestedRuntime);
      }
      enqueueComposerCommand({
        mode: action === 'insert' ? 'append' : 'replace',
        text: renderedContent,
        threadId: activeThreadId,
      });
      await recordAppliedUsage(item.id, action);
    },
    [
      activeThreadId,
      createThread,
      enqueueComposerCommand,
      getAvailableProviders,
      modelOptions,
      recordAppliedUsage,
      repository,
      setThreadDraftRuntime,
      threadRepository,
    ]
  );

  if (!repository) {
    return (
      <div
        className="m-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-destructive text-xs"
        role="alert"
      >
        Prompt Workbench requires an initialized database.
      </div>
    );
  }
  if (readiness.status === 'loading' || readiness.repository !== repository) {
    return (
      <div className="grid h-full place-items-center text-muted-foreground text-xs">
        Opening Prompt Workbench…
      </div>
    );
  }
  if (readiness.status === 'error') {
    return (
      <div
        className="m-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-destructive text-xs"
        role="alert"
      >
        {readiness.error}
      </div>
    );
  }

  const systemError = [indexingError, usageError].filter(Boolean).join('\n');

  return (
    <PromptWorkbenchPanel
      {...(activeThreadId ? { activeThreadId } : {})}
      composerContext={composerContext}
      initialItems={readiness.items}
      modelOptions={modelOptions}
      onLibraryChanged={handleLibraryChanged}
      onRequestSuggestions={handleRequestSuggestions}
      onUseItem={handleUseItem}
      repository={repository}
      {...(systemError ? { systemError } : {})}
    />
  );
}
