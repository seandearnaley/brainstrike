import {
  type PromptItem,
  PromptItemRepository,
  type PromptItemUsageAction,
  usePGliteDatabase,
} from '@brainstrike/db';
import { buildLocalEmbeddingModelConfigMap } from '@brainstrike/db-explorer/embedding-models';
import { useEnsureModelRegistry } from '@brainstrike/preferences/hooks/use-model-registry';
import { useModelRegistryStore } from '@brainstrike/preferences/stores/model-registry-store';
import type { EmbeddingSetModelInfo } from '@brainstrike/vector-management';
import { useSharedSearchEmbedder } from '@brainstrike/vector-management';
import { useCallback, useEffect, useMemo, useState } from 'react';
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

export function ConnectedPromptManager() {
  const db = usePGliteDatabase();
  useEnsureModelRegistry({ db });
  const models = useModelRegistryStore((state) => state.models);
  const providers = useModelRegistryStore((state) => state.providers);
  const embedder = useSharedSearchEmbedder();
  const activeThreadId = useAssistantThreadStore(
    (state) => state.activeThreadIdByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
  );
  const createThread = useAssistantThreadStore((state) => state.createThread);
  const renameThread = useAssistantThreadStore((state) => state.renameThread);
  const setThreadDraftRuntime = useAssistantThreadStore((state) => state.setThreadDraftRuntime);
  const composerContext = useAssistantComposerCommandStore((state) =>
    activeThreadId ? (state.draftTextByThreadId[activeThreadId] ?? '') : ''
  );
  const enqueueComposerCommand = useAssistantComposerCommandStore((state) => state.enqueue);
  const [readiness, setReadiness] = useState<PromptManagerReadiness>({ status: 'loading' });
  const [indexingError, setIndexingError] = useState<string | null>(null);

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

  const indexPendingItems = useCallback(async () => {
    if (!repository) {
      throw new Error('Cannot index prompts before the database is ready.');
    }
    const modelInfo = await resolveModelInfo();
    const outcomes = await embedPendingPromptItems({ embedder, modelInfo, repository });
    const failures = outcomes.filter((outcome) => outcome.status === 'error');
    if (failures.length > 0) {
      throw new Error(failures.map((outcome) => outcome.error).join('\n'));
    }
  }, [embedder, repository, resolveModelInfo]);

  useEffect(() => {
    if (!repository) {
      return;
    }
    let current = true;
    const initialize = async (): Promise<void> => {
      let items: PromptItem[];
      try {
        await importLegacyPromptStore(repository);
        items = await repository.list();
      } catch (error) {
        if (current) {
          setReadiness({
            error: toErrorMessage(error),
            repository,
            status: 'error',
          });
        }
        return;
      }
      if (!current) {
        return;
      }
      setReadiness({ items, repository, status: 'ready' });
      try {
        await indexPendingItems();
        if (current) {
          setIndexingError(null);
        }
      } catch (error) {
        if (current) {
          setIndexingError(toErrorMessage(error));
        }
      }
    };
    void initialize();
    return () => {
      current = false;
    };
  }, [indexPendingItems, repository]);

  const handleLibraryChanged = useCallback(async () => {
    try {
      await indexPendingItems();
    } catch (error) {
      const message = toErrorMessage(error);
      setIndexingError(message);
      throw new Error(message);
    }
  }, [indexPendingItems]);

  const handleRequestSuggestions = useCallback(
    async (context: string) => {
      if (!repository) {
        throw new Error('Cannot recall prompts before the database is ready.');
      }
      const modelInfo = await resolveModelInfo();
      return queryPromptSuggestions({
        context,
        embedder,
        modelInfo,
        options: { limit: 6, threshold: 0.35 },
        repository,
      });
    },
    [embedder, repository, resolveModelInfo]
  );

  const handleUseItem = useCallback(
    async (item: PromptItem, renderedContent: string, action: PromptItemUsageAction) => {
      if (!(repository && threadRepository)) {
        throw new Error('Cannot use a prompt before the database is ready.');
      }

      if (action === 'new-thread') {
        const thread = await createThread(threadRepository, WORKSPACE_MEMORY_RESOURCE_ID);
        await renameThread(threadRepository, WORKSPACE_MEMORY_RESOURCE_ID, thread.id, item.title);
        if (item.modelKey) {
          setThreadDraftRuntime(thread.id, parseCompositeModelKey(item.modelKey));
        }
        enqueueComposerCommand({
          mode: 'replace',
          text: renderedContent,
          threadId: thread.id,
        });
        await repository.recordUsage(item.id, action);
        return;
      }

      if (!activeThreadId) {
        throw new Error('Open an assistant thread before adding a prompt to the composer.');
      }
      enqueueComposerCommand({
        mode: action === 'insert' ? 'append' : 'replace',
        text: renderedContent,
        threadId: activeThreadId,
      });
      await repository.recordUsage(item.id, action);
    },
    [
      activeThreadId,
      createThread,
      enqueueComposerCommand,
      renameThread,
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
      {...(indexingError ? { systemError: indexingError } : {})}
    />
  );
}
