import type { RuntimeModelSettings } from '@brainstrike/assistant-contract';
import { isSupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
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
import {
  type AssistantThreadDraftRuntime,
  useAssistantThreadStore,
} from './assistant-thread-store';
import {
  buildDraftRuntimeForProvider,
  copyProviderSettingsMap,
} from './assistant-ui-panel-wrapper-runtime';
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

const PROMPT_MODEL_SETTING_KEYS = new Set([
  'frequencyPenalty',
  'maxOutputTokens',
  'maxTokens',
  'model',
  'presencePenalty',
  'temperature',
  'topP',
]);

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Prompt model setting "${field}" must be a finite number.`);
  }
  return value;
}

function requireUnitInterval(value: unknown, field: string): number {
  const number = requireFiniteNumber(value, field);
  if (number < 0 || number > 1) {
    throw new Error(`Prompt model setting "${field}" must be between 0 and 1.`);
  }
  return number;
}

function requirePenalty(value: unknown, field: string): number {
  const number = requireFiniteNumber(value, field);
  if (number < -2 || number > 2) {
    throw new Error(`Prompt model setting "${field}" must be between -2 and 2.`);
  }
  return number;
}

function requireTemperature(value: unknown): number {
  const number = requireFiniteNumber(value, 'temperature');
  if (number < 0 || number > 2) {
    throw new Error('Prompt model setting "temperature" must be between 0 and 2.');
  }
  return number;
}

function requireOutputTokenLimit(value: unknown, field: string): number {
  const number = requireFiniteNumber(value, field);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Prompt model setting "${field}" must be a positive integer.`);
  }
  return number;
}

function parsePromptModelSettings(item: PromptItem): RuntimeModelSettings | undefined {
  const raw = item.modelSettings;
  if (!raw) {
    return;
  }

  const unknownKeys = Object.keys(raw).filter((key) => !PROMPT_MODEL_SETTING_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `Prompt "${item.title}" has unsupported model settings: ${unknownKeys.join(', ')}.`
    );
  }

  if (raw['model'] !== undefined && (typeof raw['model'] !== 'string' || !raw['model'].trim())) {
    throw new Error('Prompt model setting "model" must be a non-empty string.');
  }

  const legacyMaxTokens = raw['maxTokens'];
  const maxOutputTokens = raw['maxOutputTokens'];
  if (legacyMaxTokens !== undefined && maxOutputTokens !== undefined) {
    throw new Error('Prompt model settings cannot specify both "maxTokens" and "maxOutputTokens".');
  }

  const settings: RuntimeModelSettings = {};
  const outputTokenLimit = maxOutputTokens ?? legacyMaxTokens;
  if (outputTokenLimit !== undefined) {
    settings.maxOutputTokens = requireOutputTokenLimit(
      outputTokenLimit,
      maxOutputTokens === undefined ? 'maxTokens' : 'maxOutputTokens'
    );
  }
  if (raw['temperature'] !== undefined) {
    settings.temperature = requireTemperature(raw['temperature']);
  }
  if (raw['topP'] !== undefined) {
    settings.topP = requireUnitInterval(raw['topP'], 'topP');
  }
  if (raw['frequencyPenalty'] !== undefined) {
    settings.frequencyPenalty = requirePenalty(raw['frequencyPenalty'], 'frequencyPenalty');
  }
  if (raw['presencePenalty'] !== undefined) {
    settings.presencePenalty = requirePenalty(raw['presencePenalty'], 'presencePenalty');
  }
  return Object.keys(settings).length > 0 ? settings : undefined;
}

function mergeProviderOptions(
  current: AssistantThreadDraftRuntime['providerOptions'],
  next: AssistantThreadDraftRuntime['providerOptions']
): AssistantThreadDraftRuntime['providerOptions'] {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }
  return mergeOptionRecords(current, next);
}

function isOptionRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeOptionRecords(
  current: Record<string, unknown>,
  next: Record<string, unknown>
): Record<string, unknown> {
  const merged = new Map(Object.entries(current));
  for (const [providerId, options] of Object.entries(next)) {
    const currentOptions = merged.get(providerId);
    merged.set(
      providerId,
      isOptionRecord(currentOptions) && isOptionRecord(options)
        ? mergeOptionRecords(currentOptions, options)
        : options
    );
  }
  return Object.fromEntries(merged);
}

function mergeModelSettings(
  current: AssistantThreadDraftRuntime['modelSettings'],
  rebuilt: AssistantThreadDraftRuntime['modelSettings'],
  requested: RuntimeModelSettings | undefined
): RuntimeModelSettings | undefined {
  const settings = { ...rebuilt, ...current, ...requested };
  return Object.keys(settings).length > 0 ? settings : undefined;
}

function omitModelSettings(runtime: AssistantThreadDraftRuntime): AssistantThreadDraftRuntime {
  const { modelSettings: _modelSettings, ...runtimeWithoutModelSettings } = runtime;
  return runtimeWithoutModelSettings;
}

function buildPromptDraftRuntime(
  current: AssistantThreadDraftRuntime | undefined,
  requested: ResolvedPromptRuntime,
  fallbackProviderSettings: NonNullable<AssistantThreadDraftRuntime['providerSettings']>
): AssistantThreadDraftRuntime {
  if (!isSupportedProvider(requested.provider)) {
    throw new Error(`Prompt item has an unsupported provider: ${requested.provider}`);
  }
  const providerSettingsMap = copyProviderSettingsMap(current?.providerSettings) ?? {};
  const hadCurrentTargetSettings = Object.hasOwn(providerSettingsMap, requested.provider);
  const currentTargetSettings = providerSettingsMap[requested.provider];
  const fallbackTargetSettings = fallbackProviderSettings[requested.provider];
  const effectiveTargetSettings = {
    ...fallbackTargetSettings,
    ...currentTargetSettings,
  };
  if (hadCurrentTargetSettings || Object.keys(effectiveTargetSettings).length > 0) {
    providerSettingsMap[requested.provider] = effectiveTargetSettings;
  }
  const rebuilt = buildDraftRuntimeForProvider({
    model: requested.model,
    provider: requested.provider,
    providerSettingsMap,
  });
  const providerOptions = mergeProviderOptions(current?.providerOptions, rebuilt.providerOptions);
  const modelSettings = mergeModelSettings(
    current?.provider === requested.provider ? current.modelSettings : undefined,
    rebuilt.modelSettings,
    requested.modelSettings
  );
  const preservedCurrent =
    current && current.provider !== requested.provider ? omitModelSettings(current) : current;
  return {
    ...preservedCurrent,
    ...rebuilt,
    ...(providerOptions ? { providerOptions } : {}),
    ...(modelSettings ? { modelSettings } : {}),
  };
}

interface ResolvedPromptRuntime {
  readonly model: string;
  readonly modelSettings?: RuntimeModelSettings;
  readonly provider: string;
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
}): Promise<ResolvedPromptRuntime | null> {
  if (!(action === 'compose' || action === 'new-thread')) {
    return null;
  }
  if (!item.modelKey) {
    if (item.modelSettings && Object.keys(item.modelSettings).length > 0) {
      throw new Error(`Prompt "${item.title}" has model settings without a configured model.`);
    }
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
  const modelSettings = parsePromptModelSettings(item);
  return {
    ...requestedRuntime,
    ...(modelSettings ? { modelSettings } : {}),
  };
}

interface ConnectedPromptManagerProps {
  readonly loadEmbeddingQueue: (() => Promise<QueueAdapter>) | null;
  readonly suggestionsEnabled?: boolean;
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

export function ConnectedPromptManager({
  loadEmbeddingQueue,
  suggestionsEnabled = true,
}: ConnectedPromptManagerProps) {
  const db = usePGliteDatabase();
  useEnsureModelRegistry({ db });
  const models = useModelRegistryStore((state) => state.models);
  const providers = useModelRegistryStore((state) => state.providers);
  const getAvailableProviders = useAssistantPreferencesStore(
    (state) => state.getAvailableProviders
  );
  const providerSettings = useAssistantPreferencesStore((state) => state.providerSettings);
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
      if (!renderedContent.trim()) {
        throw new Error('Rendered prompt content must contain non-whitespace text.');
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
          setThreadDraftRuntime(
            thread.id,
            buildPromptDraftRuntime(
              useAssistantThreadStore.getState().draftRuntimeByThreadId[thread.id],
              requestedRuntime,
              providerSettings
            )
          );
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
        setThreadDraftRuntime(
          activeThreadId,
          buildPromptDraftRuntime(
            useAssistantThreadStore.getState().draftRuntimeByThreadId[activeThreadId],
            requestedRuntime,
            providerSettings
          )
        );
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
      providerSettings,
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
      suggestionsEnabled={suggestionsEnabled}
      {...(systemError ? { systemError } : {})}
    />
  );
}
