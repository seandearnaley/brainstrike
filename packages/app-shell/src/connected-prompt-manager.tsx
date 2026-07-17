import type { RuntimeModelSettings } from '@brainstrike/assistant-contract';
import { isSupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import {
  type PromptItem,
  PromptItemRepository,
  type PromptItemUsageAction,
  useDbInitializationStatus,
  usePGliteDatabase,
} from '@brainstrike/db';
import { buildLocalEmbeddingModelConfigMap } from '@brainstrike/db-explorer/embedding-models';
import { useEnsureModelRegistry } from '@brainstrike/preferences/hooks/use-model-registry';
import { useAssistantPreferencesStore } from '@brainstrike/preferences/stores/assistant-preferences-store';
import { useModelRegistryStore } from '@brainstrike/preferences/stores/model-registry-store';
import type { QueueAdapter } from '@brainstrike/queue';
import { useSharedSearchEmbedder } from '@brainstrike/vector-management';
import { useCallback, useMemo, useState } from 'react';
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
import { type PromptWorkbenchModelOption, PromptWorkbenchPanel } from './prompt-workbench-panel';
import {
  toPromptWorkbenchErrorMessage,
  usePromptLibraryController,
} from './use-prompt-library-controller';

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

export function ConnectedPromptManager({
  loadEmbeddingQueue,
  suggestionsEnabled = true,
}: ConnectedPromptManagerProps) {
  const db = usePGliteDatabase();
  const dbInitializationStatus = useDbInitializationStatus();
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
    suggestionsEnabled && activeThreadId ? (state.draftTextByThreadId[activeThreadId] ?? '') : ''
  );
  const enqueueComposerCommand = useAssistantComposerCommandStore((state) => state.enqueue);
  const [usageError, setUsageError] = useState<string | null>(null);

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
  const { handleLibraryChanged, handleRequestSuggestions, indexingError, readiness } =
    usePromptLibraryController({
      embedder,
      loadEmbeddingQueue,
      localModelConfigMap,
      repository,
      suggestionsEnabled,
    });

  const recordAppliedUsage = useCallback(
    async (itemId: string, action: PromptItemUsageAction): Promise<void> => {
      if (!repository) {
        throw new Error('Cannot record prompt usage before the database is ready.');
      }
      try {
        await repository.recordUsage(itemId, action);
        setUsageError(null);
      } catch (error) {
        setUsageError(
          `Prompt was staged, but usage tracking failed: ${toPromptWorkbenchErrorMessage(error)}`
        );
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
    // Lazy DB init is still in flight (usePGliteDatabase triggers it) — this is
    // the normal startup path, not a failure. Only a terminal init state without
    // a database is a real error.
    if (dbInitializationStatus === 'idle' || dbInitializationStatus === 'initializing') {
      return (
        <div className="grid h-full place-items-center text-muted-foreground text-xs">
          Opening Prompt Workbench…
        </div>
      );
    }
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
