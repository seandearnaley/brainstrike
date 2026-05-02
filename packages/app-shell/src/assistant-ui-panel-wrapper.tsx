import type {
  AnthropicProviderOptions,
  GoogleProviderOptions,
  LocalProviderOptions,
  OpenAiProviderOptions,
  RuntimeAssistantMemorySettings,
  RuntimeData,
} from '@brainstrike/agent';
import { LocalLlmBackend } from '@brainstrike/agent/local-llm';
import {
  isLoadedRuntimeModelCatalogState,
  type LocalRuntimeAvailabilityState,
  type LocalRuntimeId,
  type LocalRuntimeModelCatalogState,
} from '@brainstrike/agent/local-runtime';
import {
  getProviderDefaultModel,
  getProviderDefinition,
  getProviderModelDefinitions,
  isSupportedProvider,
  type ProviderModelDefinition,
  type ProviderRuntime,
  type SupportedProvider,
  supportsStandardEmbeddingDimension,
} from '@brainstrike/agent/provider-metadata';
import {
  getToolSchemaDisplay,
  NATIVE_TOOL_DEFAULTS,
  TOOL_DESCRIPTIONS,
} from '@brainstrike/agent/tool-metadata';
import { useDbInitializing, useDbProviderError, usePGliteDatabase } from '@brainstrike/db';
import {
  useFileExplorerStoreSelector,
  useOptionalTokenCacheContext,
  useSelectionManager,
} from '@brainstrike/file-explorer-ui';
import { useEnsureModelRegistry } from '@brainstrike/preferences/hooks/use-model-registry';
import { useAssistantMemoryPreferencesStore } from '@brainstrike/preferences/stores/assistant-memory-preferences-store';
import { useAssistantPreferencesStore } from '@brainstrike/preferences/stores/assistant-preferences-store';
import { useModelRegistryStore } from '@brainstrike/preferences/stores/model-registry-store';
import { useNativeToolPreferencesStore } from '@brainstrike/preferences/stores/native-tool-preferences-store';
import { usePanelLayoutStore } from '@brainstrike/preferences/stores/panel-layout-store';
import { useSecretsStore } from '@brainstrike/preferences/stores/secrets-store';
import { useVectorStatusUIStore } from '@brainstrike/preferences/stores/vector-status-ui-store';
import type { AssistantSelectionUpdatePayload } from '@brainstrike/types';
import { buildWorkspaceLookupCandidates, normalizeWorkspaceLookupPath } from '@brainstrike/types';
import {
  type AssistantContextMenuConfig,
  type AssistantProviderSettings,
  type AssistantProviderSettingsUpdate,
  type AssistantToolMenuConfig,
  type AssistantToolMenuItem,
  AssistantUiPanel,
  type ModelPickerModel,
  type ModelPickerProvider,
  type ProviderGroupConfig,
} from '@brainstrike/ui/assistant-ui-panel';
import { createSafeStorageAdapter } from '@brainstrike/utils/safe-storage';
import { decodeFileSelection, encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  type AssistantThreadRepository,
  type AssistantThreadRunRecord,
  type AssistantThreadRuntimeKind,
  createAssistantThreadHistoryAdapter,
  createPgliteAssistantThreadRepository,
} from './assistant-memory-repository';
import { useAssistantThreadStore } from './assistant-thread-store';

export interface AssistantUiPanelWrapperProps {
  className?: string;
  initialProviders?: SupportedProvider[];
  memoryResourceId?: string;
  memoryThreadId?: string;
}

// App-shell wrapper wires DB/preferences state into the shared UI-only AssistantUiPanel.
const RUNTIME_LABELS: Record<ProviderRuntime, string> = {
  hosted: 'Hosted',
  gateway: 'Gateway',
  local: 'Local',
  browser: 'Browser',
};

function resolveModelNameFromComposite(composite: string | null | undefined): string | undefined {
  if (!composite) {
    return;
  }
  const parts = composite.split('::');
  return parts.length === 2 ? parts[1] : composite;
}

function resolveProviderFromComposite(
  composite: string | null | undefined
): SupportedProvider | null {
  if (!composite) {
    return null;
  }
  const parts = composite.split('::');
  const candidate = parts.length === 2 ? parts[0] : null;
  return candidate && isSupportedProvider(candidate) ? candidate : null;
}

function formatToolLabel(toolId: string): string {
  const name = toolId.split('.').pop() ?? toolId;
  const spaced = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .trim();
  return spaced.replace(/\b\w/g, (match) => match.toUpperCase());
}

function getToolDescription(toolId: string): string {
  return TOOL_DESCRIPTIONS[toolId] ?? `Tool: ${toolId}`;
}

const INCLUDE_FILE_REPORT_STORAGE_KEY = 'brainstrike.assistant.include-file-report.v1';
const includeFileReportStorage = createSafeStorageAdapter();
const TREE_CONTEXT_LINE_LIMIT = 400;
const TREE_TOKEN_ESTIMATE_PER_LINE = 4;
const FILE_REPORT_OVERHEAD_PER_FILE = 8;

function createThreadRunId(): string {
  return `run-${crypto.randomUUID()}`;
}

function toAssistantThreadRuntimeKind(runtime: ProviderRuntime): AssistantThreadRuntimeKind {
  switch (runtime) {
    case 'browser':
    case 'gateway':
    case 'hosted':
    case 'local':
      return runtime;
  }
}

function hasDesktopAssistantBackend(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return Boolean(window.assistant?.url || window.assistant?.getUrl);
}

function resolveAssistantMemoryDisabledReason(args: {
  assistantThreadRepository: AssistantThreadRepository | null;
  dbError: Error | null;
  dbInitializing: boolean;
  desktopAssistantBackendAvailable: boolean;
  memoryLoadState:
    | { readonly status: 'idle' }
    | { readonly status: 'loading' }
    | { readonly status: 'ready' }
    | { readonly error: string; readonly status: 'error' }
    | null;
  selectedMemoryThreadId: string | undefined;
  selectedProvider: SupportedProvider | null;
  workspaceRootPath: string | null;
}): string | undefined {
  if (!args.workspaceRootPath) {
    return;
  }
  if (args.dbError) {
    return `Assistant memory database failed to initialize: ${args.dbError.message}`;
  }
  if (
    args.dbInitializing ||
    !args.assistantThreadRepository ||
    args.memoryLoadState?.status === 'loading'
  ) {
    return 'Assistant memory is loading from PGlite.';
  }
  if (args.memoryLoadState?.status === 'error') {
    return `Assistant memory failed to load: ${args.memoryLoadState.error}`;
  }
  if (!args.selectedMemoryThreadId) {
    return 'Assistant memory has no selected thread for this workspace.';
  }
  if (!(args.selectedProvider === 'local' || args.desktopAssistantBackendAvailable)) {
    return 'Assistant memory for hosted providers requires the desktop assistant backend.';
  }
  return;
}

function createAssistantThreadRunPromise(args: {
  assistantThreadRepository: AssistantThreadRepository | null;
  memoryResourceId: string | undefined;
  modelSettings: RuntimeData['modelSettings'] | undefined;
  providerOptions: Record<string, unknown> | undefined;
  resolvedModelName: string | undefined;
  selectedMemoryThreadId: string | undefined;
  selectedProvider: SupportedProvider | null;
}): Promise<string | undefined> {
  if (!(args.assistantThreadRepository && args.memoryResourceId && args.selectedMemoryThreadId)) {
    throw new Error('Assistant run records require an active memory thread.');
  }
  if (!(args.selectedProvider && args.resolvedModelName)) {
    throw new Error('Assistant run records require a selected provider and model.');
  }

  const providerDefinition = getProviderDefinition(args.selectedProvider);
  const runId = createThreadRunId();
  return args.assistantThreadRepository
    .createThreadRun({
      id: runId,
      resourceId: args.memoryResourceId,
      threadId: args.selectedMemoryThreadId,
      provider: args.selectedProvider,
      model: args.resolvedModelName,
      runtimeKind: toAssistantThreadRuntimeKind(providerDefinition.runtime),
      ...(args.modelSettings ? { modelSettings: { ...args.modelSettings } } : {}),
      ...(args.providerOptions ? { providerOptions: { ...args.providerOptions } } : {}),
    })
    .then((record: AssistantThreadRunRecord) => record.id);
}

function buildAssistantRequestData(args: {
  activeEmbeddingSetId: string | null;
  contextTokenCount: number;
  hostedMemoryBackendAvailable: boolean;
  includeFileReport: boolean;
  includeProjectTree: boolean;
  memoryResourceId: string | undefined;
  memorySettings: RuntimeAssistantMemorySettings;
  modelSettings: RuntimeData['modelSettings'] | undefined;
  providerOptions: Record<string, unknown> | undefined;
  selectedMemoryThreadId: string | undefined;
  selectionData: {
    filePaths: string[];
    folderId: string | null | undefined;
  };
  tokenBudget: number | undefined;
  workspaceRootPath: string | null;
}): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (args.activeEmbeddingSetId) {
    data['embeddingSetId'] = args.activeEmbeddingSetId;
  }
  if (args.selectionData.filePaths.length > 0) {
    data['selectionFilePaths'] = args.selectionData.filePaths;
  }
  if (args.selectionData.folderId) {
    data['selectionFolderId'] = args.selectionData.folderId;
  }
  if (args.workspaceRootPath) {
    data['workspaceRootPath'] = args.workspaceRootPath;
  }
  if (args.memoryResourceId && args.selectedMemoryThreadId && args.hostedMemoryBackendAvailable) {
    data['memory'] = {
      threadId: args.selectedMemoryThreadId,
      resourceId: args.memoryResourceId,
      memorySettings: args.memorySettings,
      memoryOptions: {
        lastMessages: 40,
        workingMemory: { enabled: true, scope: 'resource' },
      },
    };
  }
  if (typeof args.tokenBudget === 'number') {
    data['tokenBudget'] = args.tokenBudget;
  }
  data['includeFileReport'] = args.includeFileReport;
  data['includeProjectTree'] = args.includeProjectTree;
  data['contextTokenCount'] = args.contextTokenCount;
  if (args.modelSettings) {
    data['modelSettings'] = args.modelSettings;
  }
  if (args.providerOptions) {
    data['providerOptions'] = args.providerOptions;
  }
  return data;
}

function resolveAssistantProviderDisabledReason(args: {
  configuredProviders: SupportedProvider[];
  currentModel: string | null | undefined;
  getProviderLlmModels: (provider: SupportedProvider) => readonly LlmProviderModelDefinition[];
  localRuntimeHint: string | undefined;
  providerHasEnabledModels: (provider: SupportedProvider) => boolean;
  selectedProvider: SupportedProvider | null;
}): string | undefined {
  const localRuntimeProviderReason = resolveLocalRuntimeProviderDisabledReason(
    args.selectedProvider,
    args.configuredProviders
  );
  if (localRuntimeProviderReason) {
    return localRuntimeProviderReason;
  }

  const builtInLocalReason = resolveBuiltInLocalProviderDisabledReason(args.selectedProvider);
  if (builtInLocalReason) {
    return builtInLocalReason;
  }

  if (args.configuredProviders.length === 0) {
    const baseReason =
      'Connect an AI provider in Settings → LLM Provider Keys to enable the assistant.';
    return args.localRuntimeHint ? `${baseReason} ${args.localRuntimeHint}` : baseReason;
  }
  if (!args.selectedProvider) {
    return 'Select an AI provider to start chatting.';
  }
  if (!args.configuredProviders.includes(args.selectedProvider)) {
    return 'The selected provider is no longer configured.';
  }

  const providerModelIds = args
    .getProviderLlmModels(args.selectedProvider)
    .map((model) => model.id);
  const unavailableLocalModelReason = resolveSelectedLocalModelUnavailableReason({
    selectedProvider: args.selectedProvider,
    selectedModel: args.currentModel ?? null,
    providerModelIds,
  });
  if (unavailableLocalModelReason) {
    return unavailableLocalModelReason;
  }

  if (!args.providerHasEnabledModels(args.selectedProvider)) {
    const definition = getProviderDefinition(args.selectedProvider);
    return `Enable at least one model for ${definition.displayName} to continue.`;
  }
  if (!args.currentModel) {
    return 'Select a model for the chosen provider to continue.';
  }
  return;
}

function resolveProviderModelSelection(args: {
  getProviderLlmModels: (provider: SupportedProvider) => readonly LlmProviderModelDefinition[];
  isModelEnabled: (providerId: SupportedProvider, modelId: string) => boolean;
  provider: SupportedProvider;
}): string | undefined {
  const enabledModels = args
    .getProviderLlmModels(args.provider)
    .filter((model: LlmProviderModelDefinition) => args.isModelEnabled(args.provider, model.id))
    .map((model: LlmProviderModelDefinition) => model.id);

  if (enabledModels.length === 0) {
    return;
  }

  const defaultModel = getProviderDefaultModel(args.provider);
  return enabledModels.includes(defaultModel ?? '') ? defaultModel : enabledModels[0];
}

function hasValidProviderModelSelection(args: {
  currentProvider: SupportedProvider;
  currentSelectedModel: string | null;
  isModelEnabled: (providerId: SupportedProvider, modelId: string) => boolean;
}): boolean {
  const currentModelName = resolveModelNameFromComposite(args.currentSelectedModel);
  if (!currentModelName) {
    return false;
  }
  return args.isModelEnabled(args.currentProvider, currentModelName);
}

function resolveLocalRuntimeSelection(args: {
  currentProvider: SupportedProvider;
  currentSelectedModel: string | null;
  isModelEnabled: (providerId: SupportedProvider, modelId: string) => boolean;
  providerHasEnabledModels: (provider: SupportedProvider) => boolean;
  selectModelForProvider: (provider: SupportedProvider) => void;
}): boolean {
  if (!isLocalRuntimeProvider(args.currentProvider)) {
    return false;
  }

  const currentModelName = resolveModelNameFromComposite(args.currentSelectedModel);
  if (currentModelName && args.isModelEnabled(args.currentProvider, currentModelName)) {
    return true;
  }

  if (args.providerHasEnabledModels(args.currentProvider)) {
    args.selectModelForProvider(args.currentProvider);
    return true;
  }
  return false;
}

interface TokenCountRow {
  path: string;
  tokenCount: number | null;
}

interface TotalFilesRow {
  count: string | number;
}

type LocalRuntimeStatusMap = Record<LocalRuntimeId, LocalRuntimeAvailabilityState>;
type LocalRuntimeModelCatalogMap = Partial<Record<LocalRuntimeId, LocalRuntimeModelCatalogState>>;
type LlmProviderModelDefinition = ProviderModelDefinition & { type: 'llm' };

const LOCAL_RUNTIME_PROVIDER_IDS = ['ollama', 'lmstudio'] as const;
type LocalRuntimeProviderId = (typeof LOCAL_RUNTIME_PROVIDER_IDS)[number];

function isLocalRuntimeProvider(
  providerId: SupportedProvider | null | undefined
): providerId is LocalRuntimeProviderId {
  if (!providerId) {
    return false;
  }
  return LOCAL_RUNTIME_PROVIDER_IDS.includes(providerId as LocalRuntimeProviderId);
}

function toRuntimeProviderModels(
  providerId: LocalRuntimeProviderId,
  catalog: LocalRuntimeModelCatalogMap | null
): readonly LlmProviderModelDefinition[] {
  const runtimeState = catalog?.[providerId];
  if (!isLoadedRuntimeModelCatalogState(runtimeState)) {
    return [];
  }

  const llmCandidates = runtimeState.models.filter((model) => model.capabilities.llm);
  return llmCandidates.map((model, index) => ({
    id: model.modelId,
    label: model.displayName,
    type: 'llm' as const,
    default: index === 0,
    supportsStreaming: true,
  }));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function addValuesToSet(target: Set<string>, values: Iterable<string>): void {
  for (const value of values) {
    if (value.length > 0) {
      target.add(value);
    }
  }
}

function getBuiltInLocalPreferenceModelIds(
  enabledModelsByProvider: Record<SupportedProvider, string[]>
): string[] {
  return (enabledModelsByProvider.local ?? []).filter(isNonEmptyString);
}

// Browser-local models are DB-backed in the split assistant chunk; the registry id is the
// authoritative runtime id when static provider metadata has not produced a usable id yet.
function getEnabledBuiltInLocalRegistryModelIds(
  registryModels: readonly {
    capabilities: { type?: unknown };
    id: unknown;
    isEnabled: unknown;
    providerId: unknown;
  }[]
): string[] {
  const modelIds: string[] = [];
  for (const model of registryModels) {
    if (
      model.providerId === 'local' &&
      model.isEnabled === true &&
      model.capabilities.type === 'llm' &&
      isNonEmptyString(model.id)
    ) {
      modelIds.push(model.id);
    }
  }
  return modelIds;
}

function addPreferenceEnabledModelIds(
  target: Set<string>,
  configuredProviders: readonly SupportedProvider[],
  enabledModelsByProvider: Record<SupportedProvider, string[]>
): void {
  for (const providerId of configuredProviders) {
    const enabledModels = enabledModelsByProvider[providerId] ?? [];
    addValuesToSet(target, enabledModels);
  }
}

function addBuiltInLocalPreferenceModelIds(
  target: Set<string>,
  configuredProviders: readonly SupportedProvider[],
  enabledModelsByProvider: Record<SupportedProvider, string[]>
): void {
  if (!configuredProviders.includes('local')) {
    return;
  }
  addValuesToSet(target, getBuiltInLocalPreferenceModelIds(enabledModelsByProvider));
}

function addRuntimeCatalogEnabledLlmModelIds(
  target: Set<string>,
  localRuntimeModels: LocalRuntimeModelCatalogMap | null
): void {
  for (const runtimeId of LOCAL_RUNTIME_PROVIDER_IDS) {
    const runtimeState = localRuntimeModels?.[runtimeId];
    if (!isLoadedRuntimeModelCatalogState(runtimeState)) {
      continue;
    }
    for (const model of runtimeState.models) {
      if (model.capabilities.llm) {
        target.add(model.modelId);
      }
    }
  }
}

function buildEnabledModelIdSet(options: {
  readonly shouldFallbackToPreferences: boolean;
  readonly configuredProviders: readonly SupportedProvider[];
  readonly enabledModelsByProvider: Record<SupportedProvider, string[]>;
  readonly registryEnabledModelIds: ReadonlySet<string>;
  readonly localRuntimeModels: LocalRuntimeModelCatalogMap | null;
}): Set<string> {
  const enabledIds = new Set<string>();

  if (options.shouldFallbackToPreferences) {
    addPreferenceEnabledModelIds(
      enabledIds,
      options.configuredProviders,
      options.enabledModelsByProvider
    );
  } else {
    addValuesToSet(enabledIds, options.registryEnabledModelIds);
  }

  addBuiltInLocalPreferenceModelIds(
    enabledIds,
    options.configuredProviders,
    options.enabledModelsByProvider
  );
  addRuntimeCatalogEnabledLlmModelIds(enabledIds, options.localRuntimeModels);
  return enabledIds;
}

function resolveLocalRuntimeProviderDisabledReason(
  selectedProvider: SupportedProvider | null,
  configuredProviders: readonly SupportedProvider[]
): string | undefined {
  if (
    selectedProvider &&
    isLocalRuntimeProvider(selectedProvider) &&
    (configuredProviders.length === 0 || !configuredProviders.includes(selectedProvider))
  ) {
    return 'The selected local runtime is currently unavailable.';
  }
  return;
}

function resolveBuiltInLocalProviderDisabledReason(
  selectedProvider: SupportedProvider | null
): string | undefined {
  if (selectedProvider !== 'local') {
    return;
  }
  if (LocalLlmBackend.getBestDevice() !== 'webgpu') {
    return 'Local Gemma requires WebGPU. This device cannot run the built-in local model.';
  }
  return;
}

function resolveSelectedLocalModelUnavailableReason(options: {
  readonly selectedProvider: SupportedProvider;
  readonly selectedModel: string | null;
  readonly providerModelIds: readonly string[];
}): string | undefined {
  if (!isLocalRuntimeProvider(options.selectedProvider)) {
    return;
  }
  const selectedModelName = resolveModelNameFromComposite(options.selectedModel);
  if (!(selectedModelName && !options.providerModelIds.includes(selectedModelName))) {
    return;
  }
  return `The selected local model "${selectedModelName}" is unavailable.`;
}

function findFirstProviderWithEnabledModels(
  configuredProviders: readonly SupportedProvider[],
  providerHasEnabledModels: (provider: SupportedProvider) => boolean
): SupportedProvider | undefined {
  return configuredProviders.find((providerId) => providerHasEnabledModels(providerId));
}

interface QueryableTokenDatabase {
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
}

async function computeTreeTokenEstimate(
  db: QueryableTokenDatabase,
  isCancelled: () => boolean
): Promise<number> {
  try {
    const result = await db.query<TotalFilesRow>('SELECT COUNT(*) AS count FROM file_records');
    if (isCancelled()) {
      return 0;
    }
    const firstRow = result.rows[0];
    const rawCount = firstRow ? firstRow.count : undefined;
    const totalFiles =
      typeof rawCount === 'number' ? rawCount : Number.parseInt(String(rawCount ?? '0'), 10) || 0;
    const estimatedLines = Math.min(totalFiles, TREE_CONTEXT_LINE_LIMIT) + (totalFiles > 0 ? 1 : 0);
    return estimatedLines * TREE_TOKEN_ESTIMATE_PER_LINE;
  } catch {
    return 0;
  }
}

function loadStoredIncludeFileReport(): boolean {
  const raw = includeFileReportStorage.getItem(INCLUDE_FILE_REPORT_STORAGE_KEY);
  if (raw === null) {
    return true;
  }
  return raw === '1';
}

async function estimateSelectionTokenCountFromDb(
  db: QueryableTokenDatabase,
  filePaths: readonly string[]
): Promise<number> {
  const candidates = buildWorkspaceLookupCandidates(filePaths);
  if (candidates.length === 0) {
    return 0;
  }

  const result = await db.query<TokenCountRow>(
    `SELECT path, token_count AS "tokenCount"
     FROM file_records
     WHERE path = ANY($1::text[])`,
    [candidates]
  );

  const byPath = new Map<string, number>();
  for (const row of result.rows) {
    const normalized = normalizeWorkspaceLookupPath(row.path);
    if (typeof row.tokenCount === 'number') {
      byPath.set(normalized, row.tokenCount);
    }
  }

  let total = 0;
  for (const filePath of filePaths) {
    const normalized = normalizeWorkspaceLookupPath(filePath);
    const tokenCount = byPath.get(normalized);
    if (typeof tokenCount === 'number') {
      total += tokenCount;
    }
  }
  return total;
}

interface McpToolDescriptor {
  description?: string;
  enabled: boolean;
  id: string;
  inputSchema?: unknown;
}

type McpToolMap = Record<string, McpToolDescriptor[]>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function toLocalRuntimeInputSchema(toolId: string): Record<string, unknown> | undefined {
  const displaySchema = getToolSchemaDisplay(toolId);
  if (!displaySchema) {
    return;
  }

  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  for (const parameter of displaySchema.parameters) {
    const schema: Record<string, unknown> = {
      type: parameter.type === 'enum' ? 'string' : parameter.type,
      description: parameter.description,
    };
    if (parameter.type === 'enum' && parameter.enumValues) {
      schema['enum'] = parameter.enumValues;
    }
    if (parameter.type === 'array' && parameter.arrayItemType) {
      schema['items'] = {
        type: parameter.arrayItemType,
      };
    }
    properties[parameter.name] = schema;
    if (parameter.required) {
      required.push(parameter.name);
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function buildMcpMenuItems(toolsByServer: McpToolMap): AssistantToolMenuItem[] {
  const items: AssistantToolMenuItem[] = [];
  for (const [serverName, serverTools] of Object.entries(toolsByServer)) {
    for (const tool of serverTools) {
      items.push({
        id: tool.id,
        label: formatToolLabel(tool.id),
        enabled: tool.enabled,
        source: 'mcp',
        group: serverName,
        description: tool.description ?? `MCP tool: ${tool.id}`,
        category: 'action',
        ...(isPlainRecord(tool.inputSchema) ? { inputSchema: tool.inputSchema } : {}),
        isLocalRuntimeRunnable: true,
      });
    }
  }
  return items;
}

function returnIfNotEmpty<T extends Record<string, unknown>>(options: T): T | undefined {
  return Object.keys(options).length > 0 ? options : undefined;
}

function buildOptionalOptions<T extends Record<string, unknown>>(
  entries: [keyof T, unknown][]
): T | undefined {
  const options = {} as T;
  for (const [key, value] of entries) {
    if (value !== undefined) {
      options[key] = value as T[keyof T];
    }
  }
  return returnIfNotEmpty(options);
}

function buildModelSettings(
  settings: AssistantProviderSettings | undefined
): RuntimeData['modelSettings'] | undefined {
  if (!settings || typeof settings.maxOutputTokens !== 'number') {
    return;
  }
  const value = Math.max(1, Math.floor(settings.maxOutputTokens));
  return Number.isFinite(value) ? { maxOutputTokens: value } : undefined;
}

function resolveGoogleThinkingLevel(
  modelName: string | undefined,
  value: AssistantProviderSettings['googleThinkingLevel']
): AssistantProviderSettings['googleThinkingLevel'] {
  if (!value) {
    return;
  }
  const isPro = Boolean(modelName?.includes('gemini-3-pro-preview'));
  const allowed: readonly NonNullable<AssistantProviderSettings['googleThinkingLevel']>[] = isPro
    ? ['low', 'high']
    : ['minimal', 'low', 'medium', 'high'];
  return allowed.includes(value) ? value : undefined;
}

function buildOpenAiOptions(
  settings: AssistantProviderSettings
): OpenAiProviderOptions | undefined {
  return buildOptionalOptions<OpenAiProviderOptions>([
    ['reasoningEffort', settings.reasoningEffort || undefined],
    ['reasoningSummary', settings.reasoningSummary || undefined],
  ]);
}

function buildAnthropicOptions(
  settings: AssistantProviderSettings
): AnthropicProviderOptions | undefined {
  const thinking =
    typeof settings.anthropicThinkingBudgetTokens === 'number'
      ? {
          type: 'enabled' as const,
          budgetTokens: Math.floor(settings.anthropicThinkingBudgetTokens),
        }
      : undefined;
  return buildOptionalOptions<AnthropicProviderOptions>([
    ['effort', settings.anthropicEffort || undefined],
    ['thinking', thinking],
  ]);
}

function buildGoogleOptions(
  modelName: string | undefined,
  settings: AssistantProviderSettings
): GoogleProviderOptions | undefined {
  const resolvedLevel = resolveGoogleThinkingLevel(modelName, settings.googleThinkingLevel);
  const includeThoughts =
    typeof settings.googleIncludeThoughts === 'boolean'
      ? settings.googleIncludeThoughts
      : undefined;
  const thinkingConfig = buildOptionalOptions<NonNullable<GoogleProviderOptions['thinkingConfig']>>(
    [
      ['thinkingLevel', resolvedLevel],
      ['includeThoughts', includeThoughts],
    ]
  );
  return thinkingConfig ? { thinkingConfig } : undefined;
}

function buildLocalOptions(settings: AssistantProviderSettings): LocalProviderOptions | undefined {
  if (typeof settings.localThinkingEnabled !== 'boolean') {
    return;
  }
  return {
    thinking: {
      enabled: settings.localThinkingEnabled,
    },
  };
}

function buildLocalRuntimeOptions(
  settings: AssistantProviderSettings | undefined
): { baseUrl?: string } | undefined {
  const raw = settings?.localRuntimeBaseUrl;
  if (typeof raw !== 'string') {
    return;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return;
  }
  return { baseUrl: trimmed };
}

function buildProviderOptions(
  providerId: SupportedProvider | null,
  modelName: string | undefined,
  settings: AssistantProviderSettings | undefined
): RuntimeData['providerOptions'] | undefined {
  if (!(providerId && settings)) {
    return;
  }

  switch (providerId) {
    case 'openai':
    case 'openrouter': {
      const openai = buildOpenAiOptions(settings);
      return openai ? { openai } : undefined;
    }
    case 'anthropic': {
      const anthropic = buildAnthropicOptions(settings);
      return anthropic ? { anthropic } : undefined;
    }
    case 'google': {
      const google = buildGoogleOptions(modelName, settings);
      return google ? { google } : undefined;
    }
    case 'local': {
      const local = buildLocalOptions(settings);
      return local ? { local } : undefined;
    }
    case 'ollama': {
      // Forward the user's configured origin to the main-process factory. The
      // optional bearer token is not set here — the main process reads it from
      // the encrypted secrets bridge just like other providers so it never
      // crosses the renderer/server boundary in the request body.
      const ollama = buildLocalRuntimeOptions(settings);
      return ollama ? { ollama } : undefined;
    }
    case 'lmstudio': {
      const lmstudio = buildLocalRuntimeOptions(settings);
      return lmstudio ? { lmstudio } : undefined;
    }
    default:
      return;
  }
}

function copyProviderSettingsMap(
  settings: Record<string, AssistantProviderSettings> | undefined
): Record<string, AssistantProviderSettings> | undefined {
  if (!settings) {
    return;
  }
  return Object.fromEntries(
    Object.entries(settings).map(([providerId, providerSetting]) => [
      providerId,
      { ...providerSetting },
    ])
  );
}

function extractPreparedRunId(requestData: Record<string, unknown> | undefined): string | null {
  const memory = requestData?.['memory'];
  if (!(memory && typeof memory === 'object' && !Array.isArray(memory))) {
    return null;
  }
  const runId = (memory as Record<string, unknown>)['runId'];
  return typeof runId === 'string' && runId.trim() ? runId : null;
}

function mergeAssistantProviderSettings(
  base: AssistantProviderSettings | undefined,
  updates: AssistantProviderSettingsUpdate
): AssistantProviderSettings {
  const merged: Record<string, unknown> = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged as AssistantProviderSettings;
}

function buildDraftRuntimeForProvider({
  model,
  provider,
  providerSettingsMap,
}: {
  readonly model: string | undefined;
  readonly provider: SupportedProvider;
  readonly providerSettingsMap: Record<string, AssistantProviderSettings>;
}) {
  const settings = providerSettingsMap[provider];
  const modelSettings = buildModelSettings(settings);
  const providerOptions = model ? buildProviderOptions(provider, model, settings) : undefined;
  const hasProviderSettings = Object.keys(providerSettingsMap).length > 0;
  return {
    provider,
    ...(model ? { model } : {}),
    ...(hasProviderSettings ? { providerSettings: providerSettingsMap } : {}),
    ...(modelSettings ? { modelSettings } : {}),
    ...(providerOptions ? { providerOptions } : {}),
  };
}

interface McpState {
  loading: boolean;
  tools: AssistantToolMenuItem[];
}

type McpAction =
  | { type: 'LOADING' }
  | { type: 'LOADED'; tools: AssistantToolMenuItem[] }
  | { type: 'ERROR' };

function mcpReducer(_state: McpState, action: McpAction): McpState {
  switch (action.type) {
    case 'LOADING':
      return { tools: [], loading: true };
    case 'LOADED':
      return { tools: action.tools, loading: false };
    case 'ERROR':
      return { tools: [], loading: false };
  }
}

interface TokenEstimateState {
  projectTreeTokensEstimate: number;
  selectionTokensFromDb: number;
}

type TokenEstimateAction =
  | { type: 'SET_SELECTION'; tokens: number }
  | { type: 'SET_TREE'; tokens: number };

function tokenEstimateReducer(
  state: TokenEstimateState,
  action: TokenEstimateAction
): TokenEstimateState {
  switch (action.type) {
    case 'SET_SELECTION':
      return { ...state, selectionTokensFromDb: action.tokens };
    case 'SET_TREE':
      return { ...state, projectTreeTokensEstimate: action.tokens };
    default:
      return state;
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This integration wrapper coordinates multiple stores, runtime probes, and transport paths in one place.
export function AssistantUiPanelWrapper({
  initialProviders,
  memoryResourceId: memoryResourceIdOverride,
  memoryThreadId,
}: AssistantUiPanelWrapperProps) {
  const [configuredProviders, setConfiguredProviders] = useState<SupportedProvider[]>(
    () => initialProviders ?? []
  );
  const [localRuntimeStatuses, setLocalRuntimeStatuses] = useState<LocalRuntimeStatusMap | null>(
    null
  );
  const [localRuntimeModels, setLocalRuntimeModels] = useState<LocalRuntimeModelCatalogMap | null>(
    null
  );

  const {
    setModel,
    clearModel,
    getAvailableProviders,
    getLocalRuntimeStatuses,
    getLocalRuntimeModels,
    getSelectedModel,
    getSelectedProvider,
    setProviderSettings,
  } = useAssistantPreferencesStore();
  const selectedModel = useAssistantPreferencesStore((state) => state.selectedModel);
  const draftRuntimeByThreadId = useAssistantThreadStore((state) => state.draftRuntimeByThreadId);
  const setThreadDraftRuntime = useAssistantThreadStore((state) => state.setThreadDraftRuntime);
  const enabledModelsByProvider = useAssistantPreferencesStore(
    (state) => state.enabledModelsByProvider
  );
  const providerSettings = useAssistantPreferencesStore((state) => state.providerSettings);
  const observationalMemorySettings = useAssistantMemoryPreferencesStore(
    (state) => state.observationalMemory
  );
  const semanticRecallSettings = useAssistantMemoryPreferencesStore(
    (state) => state.semanticRecall
  );
  const [nativeToolStates, setNativeToolEnabled] = useNativeToolPreferencesStore(
    (state) => [state.toolStates, state.setToolEnabled] as const
  );

  // Subscribe to secrets changes to re-check available providers when API keys change
  const secretsVersion = useSecretsStore((state) => state.secretsVersion);

  // Load model registry from DB for local provider models
  useEnsureModelRegistry();
  const registryModels = useModelRegistryStore((state) => state.models);
  const registryError = useModelRegistryStore((state) => state.error);
  const toggleModelInDb = useModelRegistryStore((state) => state.toggleModel);
  const db = usePGliteDatabase();
  const tokenCache = useOptionalTokenCacheContext();
  const dbInitializing = useDbInitializing();
  const dbError = useDbProviderError();
  const setActiveTab = usePanelLayoutStore((state) => state.setActiveTab);
  const [mcpState, dispatchMcp] = useReducer(mcpReducer, { tools: [], loading: false });
  const mcpTools = mcpState.tools;
  const mcpLoading = mcpState.loading;
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const dispatchMcpIfMounted = useCallback((action: McpAction) => {
    if (isMountedRef.current) {
      dispatchMcp(action);
    }
  }, []);

  // Create a set of DB-enabled model IDs for quick lookup
  const registryEnabledModelIds = useMemo(() => {
    const enabledIds = new Set<string>();
    for (const model of registryModels) {
      if (model.isEnabled && model.capabilities.type === 'llm') {
        enabledIds.add(model.id);
      }
    }
    return enabledIds;
  }, [registryModels]);

  const shouldFallbackToPreferences = useMemo(() => {
    if (dbError || registryError) {
      return true;
    }
    if (!db) {
      return !dbInitializing;
    }
    return false;
  }, [db, dbError, dbInitializing, registryError]);

  const enabledModelIds = useMemo(
    () =>
      buildEnabledModelIdSet({
        shouldFallbackToPreferences,
        configuredProviders,
        enabledModelsByProvider,
        registryEnabledModelIds,
        localRuntimeModels,
      }),
    [
      configuredProviders,
      enabledModelsByProvider,
      localRuntimeModels,
      registryEnabledModelIds,
      shouldFallbackToPreferences,
    ]
  );
  const enabledBuiltInLocalModelIds = useMemo(() => {
    const modelIds = new Set<string>();
    addValuesToSet(modelIds, getBuiltInLocalPreferenceModelIds(enabledModelsByProvider));
    addValuesToSet(modelIds, getEnabledBuiltInLocalRegistryModelIds(registryModels));
    return [...modelIds];
  }, [enabledModelsByProvider, registryModels]);

  const runtimeLlmModelsByProvider = useMemo<
    Partial<Record<LocalRuntimeProviderId, readonly LlmProviderModelDefinition[]>>
  >(
    () => ({
      ollama: toRuntimeProviderModels('ollama', localRuntimeModels),
      lmstudio: toRuntimeProviderModels('lmstudio', localRuntimeModels),
    }),
    [localRuntimeModels]
  );

  const getProviderLlmModels = useCallback(
    (provider: SupportedProvider): readonly LlmProviderModelDefinition[] => {
      if (isLocalRuntimeProvider(provider)) {
        return runtimeLlmModelsByProvider[provider] ?? [];
      }
      return getProviderModelDefinitions(provider).filter(
        (model: ProviderModelDefinition): model is LlmProviderModelDefinition =>
          model.type === 'llm'
      );
    },
    [runtimeLlmModelsByProvider]
  );

  const selectedThreadDraftRuntime = memoryThreadId
    ? draftRuntimeByThreadId[memoryThreadId]
    : undefined;
  const selectedDraftModel =
    selectedThreadDraftRuntime?.provider && selectedThreadDraftRuntime.model
      ? `${selectedThreadDraftRuntime.provider}::${selectedThreadDraftRuntime.model}`
      : undefined;
  const currentModel = selectedDraftModel ?? selectedModel;
  const selectedProvider = useMemo(
    () => resolveProviderFromComposite(currentModel),
    [currentModel]
  );
  const resolvedModelName = useMemo(
    () => resolveModelNameFromComposite(currentModel),
    [currentModel]
  );
  const effectiveProviderSettings = useMemo(() => {
    const draftProviderSettings = selectedThreadDraftRuntime?.providerSettings;
    if (!draftProviderSettings) {
      return providerSettings;
    }
    return {
      ...providerSettings,
      ...copyProviderSettingsMap(draftProviderSettings),
    };
  }, [providerSettings, selectedThreadDraftRuntime?.providerSettings]);
  const selectedProviderSettings = selectedProvider
    ? effectiveProviderSettings[selectedProvider]
    : undefined;
  const modelSettings = useMemo(
    () => selectedThreadDraftRuntime?.modelSettings ?? buildModelSettings(selectedProviderSettings),
    [selectedProviderSettings, selectedThreadDraftRuntime?.modelSettings]
  );
  const providerOptions = useMemo(
    () =>
      selectedThreadDraftRuntime?.providerOptions ??
      buildProviderOptions(selectedProvider, resolvedModelName, selectedProviderSettings),
    [
      selectedProvider,
      resolvedModelName,
      selectedProviderSettings,
      selectedThreadDraftRuntime?.providerOptions,
    ]
  );

  useEffect(() => {
    if (!(memoryThreadId && selectedProvider && resolvedModelName)) {
      return;
    }
    if (draftRuntimeByThreadId[memoryThreadId]) {
      return;
    }
    setThreadDraftRuntime(memoryThreadId, {
      provider: selectedProvider,
      model: resolvedModelName,
    });
  }, [
    draftRuntimeByThreadId,
    memoryThreadId,
    resolvedModelName,
    selectedProvider,
    setThreadDraftRuntime,
  ]);

  const activeEmbeddingSetId = useVectorStatusUIStore((s) => s.activeEmbeddingSetId);
  const [
    tokenBudget,
    currentFolderId,
    rootDirectoryHandle,
    includeProjectTree,
    setTokenBudget,
    setIncludeProjectTree,
    setSelectedFiles,
    addMultipleSelectedFiles,
    removeMultipleSelectedFiles,
    clearSelectionRules,
  ] = useFileExplorerStoreSelector(
    (s) =>
      [
        s.tokenBudget,
        s.currentFolderId,
        s.rootDirectoryHandle,
        s.includeProjectTree,
        s.setTokenBudget,
        s.setIncludeProjectTree,
        s.setSelectedFiles,
        s.addMultipleSelectedFiles,
        s.removeMultipleSelectedFiles,
        s.clearSelectionRules,
      ] as const
  );
  const [includeFileReport, setIncludeFileReport] = useState<boolean>(() =>
    loadStoredIncludeFileReport()
  );
  const [tokenEstimateState, dispatchTokenEstimate] = useReducer(tokenEstimateReducer, {
    selectionTokensFromDb: 0,
    projectTreeTokensEstimate: 0,
  });
  const selectionTokensFromDb = tokenEstimateState.selectionTokensFromDb;
  const projectTreeTokensEstimate = tokenEstimateState.projectTreeTokensEstimate;
  const handleSelectionLimitExceeded = useCallback(() => {}, []);
  const { effectiveSelection } = useSelectionManager({
    onSelectionLimitExceeded: handleSelectionLimitExceeded,
  });
  const effectiveSelectionRef = useRef(effectiveSelection);

  useEffect(() => {
    effectiveSelectionRef.current = effectiveSelection;
  }, [effectiveSelection]);

  const selectionData = useMemo(() => {
    const filePaths = new Set<string>();
    const folderIds = new Set<string>();
    for (const compositeKey of effectiveSelection) {
      try {
        const decoded = decodeFileSelection(compositeKey);
        filePaths.add(decoded.path);
        folderIds.add(decoded.folderId);
      } catch {
        // Ignore invalid selection keys
      }
    }

    const resolvedFolderId =
      folderIds.size === 1
        ? Array.from(folderIds)[0]
        : folderIds.size === 0
          ? (currentFolderId ?? undefined)
          : undefined;

    return {
      filePaths: Array.from(filePaths),
      folderId: resolvedFolderId,
    };
  }, [effectiveSelection, currentFolderId]);

  useEffect(() => {
    includeFileReportStorage.setItem(
      INCLUDE_FILE_REPORT_STORAGE_KEY,
      includeFileReport ? '1' : '0'
    );
  }, [includeFileReport]);

  useEffect(() => {
    const folderId = selectionData.folderId;
    if (!(db && folderId && selectionData.filePaths.length > 0)) {
      dispatchTokenEstimate({ type: 'SET_SELECTION', tokens: 0 });
      return;
    }

    // BST-360: Debounce DB queries to coalesce rapid selection changes
    // (drag-select, bulk checkbox toggling). Cache-based estimates via
    // tokensFromCache memo remain instant and unaffected.
    let cancelled = false;
    const timer = setTimeout(() => {
      void estimateSelectionTokenCountFromDb(db as QueryableTokenDatabase, selectionData.filePaths)
        .then((total) => {
          if (!cancelled) {
            dispatchTokenEstimate({ type: 'SET_SELECTION', tokens: total });
          }
        })
        .catch(() => {
          if (!cancelled) {
            dispatchTokenEstimate({ type: 'SET_SELECTION', tokens: 0 });
          }
        });
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [db, selectionData.filePaths, selectionData.folderId]);

  useEffect(() => {
    if (!(db && includeProjectTree)) {
      dispatchTokenEstimate({ type: 'SET_TREE', tokens: 0 });
      return;
    }

    let cancelled = false;
    void computeTreeTokenEstimate(db, () => cancelled).then((tokens) => {
      if (!cancelled) {
        dispatchTokenEstimate({ type: 'SET_TREE', tokens });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [db, includeProjectTree]);

  const tokenCacheVersion = tokenCache?.cacheVersion;

  const tokensFromCache = useMemo(() => {
    if (!(tokenCache && selectionData.folderId && selectionData.filePaths.length > 0)) {
      return 0;
    }
    let total = 0;
    for (const path of selectionData.filePaths) {
      const count = tokenCache.getTokenCount(selectionData.folderId, path);
      if (typeof count === 'number' && Number.isFinite(count)) {
        total += count;
      }
    }
    return total;
  }, [tokenCache, tokenCacheVersion, selectionData.filePaths, selectionData.folderId]);

  const contextTokenCount = useMemo(() => {
    const selectedTokens = Math.max(tokensFromCache, selectionTokensFromDb);
    const reportOverhead = includeFileReport
      ? selectionData.filePaths.length * FILE_REPORT_OVERHEAD_PER_FILE
      : 0;
    const treeTokens = includeProjectTree ? projectTreeTokensEstimate : 0;
    return selectedTokens + reportOverhead + treeTokens;
  }, [
    includeFileReport,
    includeProjectTree,
    projectTreeTokensEstimate,
    selectionData.filePaths.length,
    selectionTokensFromDb,
    tokensFromCache,
  ]);

  const handleSelectionUpdate = useCallback(
    (payload: AssistantSelectionUpdatePayload) => {
      if (!(payload.folderId && Array.isArray(payload.filePaths) && payload.filePaths.length > 0)) {
        return;
      }
      const mode = payload.mode ?? 'add';
      const normalizedPaths: string[] = Array.from(
        new Set(
          payload.filePaths
            .map((filePath: unknown) => normalizeWorkspaceLookupPath(String(filePath)))
            .filter((path: string) => path.length > 0)
            .map((path: string) => (path.startsWith('/') ? path : `/${path}`))
        )
      );
      if (normalizedPaths.length === 0) {
        return;
      }

      if (mode === 'add') {
        addMultipleSelectedFiles(payload.folderId, normalizedPaths);
        return;
      }
      if (mode === 'remove') {
        removeMultipleSelectedFiles(payload.folderId, normalizedPaths);
        return;
      }

      clearSelectionRules();
      const next = new Set<string>();
      for (const compositeKey of effectiveSelectionRef.current) {
        try {
          const decoded = decodeFileSelection(compositeKey);
          if (decoded.folderId !== payload.folderId) {
            next.add(compositeKey);
          }
        } catch {
          next.add(compositeKey);
        }
      }
      for (const path of normalizedPaths) {
        next.add(encodeFileSelection(payload.folderId, path));
      }
      setSelectedFiles(next);
    },
    [addMultipleSelectedFiles, clearSelectionRules, removeMultipleSelectedFiles, setSelectedFiles]
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !window.tools?.onRootTreeSelectionUpdate) {
      return;
    }

    const unsubscribe = window.tools.onRootTreeSelectionUpdate(
      (payload: AssistantSelectionUpdatePayload) => {
        handleSelectionUpdate(payload);
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, [handleSelectionUpdate]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.tools?.onPreviewContextSelectionUpdate) {
      return;
    }

    const unsubscribe = window.tools.onPreviewContextSelectionUpdate(
      (payload: AssistantSelectionUpdatePayload) => {
        handleSelectionUpdate(payload);
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, [handleSelectionUpdate]);

  const nativeToolItems = useMemo<AssistantToolMenuItem[]>(
    () =>
      Object.entries(NATIVE_TOOL_DEFAULTS).map(([toolId, metadata]) => {
        const category =
          typeof (metadata as { category?: unknown }).category === 'string'
            ? (metadata as { category: string }).category
            : undefined;
        const inputSchema = toLocalRuntimeInputSchema(toolId);

        return {
          id: toolId,
          label: formatToolLabel(toolId),
          enabled: typeof nativeToolStates[toolId] === 'boolean' ? nativeToolStates[toolId] : true,
          source: 'native',
          group: 'Native Tools',
          description: getToolDescription(toolId),
          ...(inputSchema ? { inputSchema } : {}),
          isLocalRuntimeRunnable: true,
          ...(category ? { category } : {}),
        };
      }),
    [nativeToolStates]
  );

  const loadMcpTools = useCallback(async () => {
    if (typeof window === 'undefined' || !window.mcp?.listTools) {
      dispatchMcpIfMounted({ type: 'LOADED', tools: [] });
      return;
    }

    dispatchMcpIfMounted({ type: 'LOADING' });
    try {
      const toolsByServer = (await window.mcp.listTools()) as McpToolMap;
      dispatchMcpIfMounted({ type: 'LOADED', tools: buildMcpMenuItems(toolsByServer) });
    } catch {
      dispatchMcpIfMounted({ type: 'ERROR' });
    }
  }, [dispatchMcpIfMounted]);

  useEffect(() => {
    void loadMcpTools();
  }, [loadMcpTools]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.mcp?.onToolsUpdated) {
      return;
    }

    return window.mcp.onToolsUpdated((toolsByServer: McpToolMap) => {
      dispatchMcpIfMounted({ type: 'LOADED', tools: buildMcpMenuItems(toolsByServer) });
    });
  }, [dispatchMcpIfMounted]);

  const toolMenuItems = useMemo(
    () => [...nativeToolItems, ...mcpTools],
    [nativeToolItems, mcpTools]
  );

  const toolSourceById = useMemo(() => {
    const entries = toolMenuItems.map((tool) => [tool.id, tool.source] as const);
    return new Map(entries);
  }, [toolMenuItems]);

  const handleToggleTool = useCallback(
    async (toolId: string, enabled: boolean) => {
      const source = toolSourceById.get(toolId);
      if (!source) {
        return;
      }
      if (source === 'native') {
        setNativeToolEnabled(toolId, enabled);
        return;
      }

      if (enabled) {
        await window.mcp?.enableTools?.([toolId]);
      } else {
        await window.mcp?.disableTools?.([toolId]);
      }
      await loadMcpTools();
    },
    [toolSourceById, setNativeToolEnabled, loadMcpTools]
  );

  const handleOpenToolSettings = useCallback(() => {
    setActiveTab('settings');
    if (typeof window !== 'undefined') {
      window.location.hash = '#settings/ai-tools';
    }
  }, [setActiveTab]);

  const canRefreshMcp =
    typeof window !== 'undefined' && typeof window.mcp?.listTools === 'function';

  const toolMenu = useMemo<AssistantToolMenuConfig>(() => {
    const summary = toolMenuItems.length
      ? `${toolMenuItems.filter((tool) => tool.enabled).length} of ${toolMenuItems.length} enabled`
      : undefined;

    return {
      items: toolMenuItems,
      isLoading: mcpLoading,
      onToggleTool: handleToggleTool,
      onOpenSettings: handleOpenToolSettings,
      ...(summary ? { summary } : {}),
      ...(canRefreshMcp ? { onRefresh: loadMcpTools } : {}),
    };
  }, [
    canRefreshMcp,
    handleOpenToolSettings,
    handleToggleTool,
    loadMcpTools,
    mcpLoading,
    toolMenuItems,
  ]);

  const selectionCount = selectionData.filePaths.length;
  const contextMenu = useMemo<AssistantContextMenuConfig>(() => {
    const selectionLabel = selectionCount > 0 ? `${selectionCount} files selected` : undefined;

    return {
      selectionCount,
      includeFileReport,
      includeProjectTree,
      contextTokenCount,
      onIncludeFileReportChange: setIncludeFileReport,
      onIncludeProjectTreeChange: setIncludeProjectTree,
      onTokenBudgetChange: setTokenBudget,
      ...(selectionLabel ? { selectionLabel } : {}),
      ...(typeof activeEmbeddingSetId === 'string' ? { embeddingSetId: activeEmbeddingSetId } : {}),
      ...(typeof tokenBudget === 'number' ? { tokenBudget } : {}),
    };
  }, [
    activeEmbeddingSetId,
    contextTokenCount,
    includeFileReport,
    includeProjectTree,
    selectionCount,
    setIncludeProjectTree,
    setTokenBudget,
    tokenBudget,
  ]);

  const workspaceRootPath = rootDirectoryHandle?.path ?? null;
  const assistantThreadRepository = useMemo(
    () => (db ? createPgliteAssistantThreadRepository(db) : null),
    [db]
  );
  const selectedThreadByResourceId = useAssistantThreadStore(
    (state) => state.selectedThreadByResourceId
  );
  const loadStateByResourceId = useAssistantThreadStore((state) => state.loadStateByResourceId);
  const ensureResourceThreads = useAssistantThreadStore((state) => state.ensureResourceThreads);
  const memoryResourceId = memoryResourceIdOverride ?? workspaceRootPath ?? undefined;
  const selectedMemoryThreadId = memoryResourceId
    ? (memoryThreadId ?? selectedThreadByResourceId[memoryResourceId])
    : undefined;
  const memoryLoadState = memoryResourceId
    ? (loadStateByResourceId[memoryResourceId] ?? { status: 'idle' as const })
    : null;
  const desktopAssistantBackendAvailable = hasDesktopAssistantBackend();
  const hostedMemoryBackendAvailable =
    selectedProvider === 'local' ? true : desktopAssistantBackendAvailable;

  useEffect(() => {
    if (!(assistantThreadRepository && memoryResourceId)) {
      return;
    }
    ensureResourceThreads(assistantThreadRepository, memoryResourceId).catch(() => {
      // The store records the explicit error state; the assistant remains unavailable.
    });
  }, [assistantThreadRepository, ensureResourceThreads, memoryResourceId]);

  const historyAdapter = useMemo(() => {
    if (!(assistantThreadRepository && memoryResourceId && selectedMemoryThreadId)) {
      return;
    }
    return createAssistantThreadHistoryAdapter({
      repository: assistantThreadRepository,
      resourceId: memoryResourceId,
      threadId: selectedMemoryThreadId,
    });
  }, [assistantThreadRepository, memoryResourceId, selectedMemoryThreadId]);

  const runtimeMemorySettings = useMemo(
    () => ({
      observationalMemory: observationalMemorySettings,
      semanticRecall: semanticRecallSettings,
    }),
    [observationalMemorySettings, semanticRecallSettings]
  );

  const requestData = useMemo(
    () =>
      buildAssistantRequestData({
        activeEmbeddingSetId,
        contextTokenCount,
        hostedMemoryBackendAvailable,
        includeFileReport,
        includeProjectTree,
        memoryResourceId,
        memorySettings: runtimeMemorySettings,
        modelSettings,
        providerOptions,
        selectedMemoryThreadId,
        selectionData,
        tokenBudget,
        workspaceRootPath,
      }),
    [
      activeEmbeddingSetId,
      contextTokenCount,
      hostedMemoryBackendAvailable,
      includeFileReport,
      includeProjectTree,
      memoryResourceId,
      modelSettings,
      providerOptions,
      runtimeMemorySettings,
      selectedMemoryThreadId,
      selectionData,
      tokenBudget,
      workspaceRootPath,
    ]
  );

  const prepareRequestData = useCallback(async (): Promise<Record<string, unknown>> => {
    const runId = await createAssistantThreadRunPromise({
      assistantThreadRepository,
      memoryResourceId,
      modelSettings,
      providerOptions,
      resolvedModelName,
      selectedMemoryThreadId,
      selectedProvider,
    });
    const memoryContext = requestData['memory'];
    if (!(memoryContext && typeof memoryContext === 'object' && !Array.isArray(memoryContext))) {
      throw new Error('Assistant request preparation requires Mastra memory context.');
    }

    return {
      ...requestData,
      memory: {
        ...memoryContext,
        ...(runId ? { runId } : {}),
      },
    };
  }, [
    assistantThreadRepository,
    memoryResourceId,
    modelSettings,
    providerOptions,
    requestData,
    resolvedModelName,
    selectedMemoryThreadId,
    selectedProvider,
  ]);

  const completePreparedRequest = useCallback(
    async (
      preparedRequestData: Record<string, unknown> | undefined,
      status: 'cancelled' | 'completed' | 'failed',
      error?: string
    ): Promise<void> => {
      const runId = extractPreparedRunId(preparedRequestData);
      if (!runId) {
        return;
      }
      if (!assistantThreadRepository) {
        throw new Error('Assistant run completion requires an active thread repository.');
      }
      await assistantThreadRepository.completeThreadRun(runId, {
        status,
        ...(error ? { error } : {}),
      });
    },
    [assistantThreadRepository]
  );

  // Check if a model is enabled - always use DB as source of truth
  const isModelEnabled = useCallback(
    (_providerId: SupportedProvider, modelId: string): boolean => enabledModelIds.has(modelId),
    [enabledModelIds]
  );

  const providerHasEnabledModels = useCallback(
    (provider: SupportedProvider) => {
      if (provider === 'local' && enabledBuiltInLocalModelIds.length > 0) {
        return true;
      }
      const modelDefinitions = getProviderLlmModels(provider);
      return modelDefinitions.some((model: LlmProviderModelDefinition) =>
        enabledModelIds.has(model.id)
      );
    },
    [enabledBuiltInLocalModelIds, enabledModelIds, getProviderLlmModels]
  );

  const selectModelForProvider = useCallback(
    (provider: SupportedProvider) => {
      const modelToSelect =
        resolveProviderModelSelection({
          getProviderLlmModels,
          isModelEnabled,
          provider,
        }) ?? (provider === 'local' ? enabledBuiltInLocalModelIds[0] : undefined);
      if (!modelToSelect) {
        return;
      }
      setModel(`${provider}::${modelToSelect}`);
    },
    [enabledBuiltInLocalModelIds, getProviderLlmModels, isModelEnabled, setModel]
  );

  useEffect(() => {
    let cancelled = false;

    const loadProviders = async () => {
      if (initialProviders !== undefined) {
        setConfiguredProviders(initialProviders);
        return;
      }

      const providers = await getAvailableProviders();
      if (cancelled) {
        return;
      }
      setConfiguredProviders(providers);
    };

    void loadProviders();

    return () => {
      cancelled = true;
    };
    // secretsVersion triggers re-check when API keys are added/removed
  }, [initialProviders, getAvailableProviders, secretsVersion]);

  useEffect(() => {
    let cancelled = false;
    setLocalRuntimeStatuses({
      ollama: { state: 'checking' },
      lmstudio: { state: 'checking' },
    });

    void getLocalRuntimeStatuses()
      .then((statuses) => {
        if (!cancelled) {
          setLocalRuntimeStatuses(statuses);
        }
      })
      .catch(() => {
        if (!cancelled) {
          const fallback = {
            state: 'unavailable' as const,
            checkedAt: Date.now(),
            message: 'Local runtime probe failed',
          };
          setLocalRuntimeStatuses({
            ollama: fallback,
            lmstudio: fallback,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [getLocalRuntimeStatuses]);

  useEffect(() => {
    if (!localRuntimeStatuses) {
      return;
    }
    const isCheckingStatuses = LOCAL_RUNTIME_PROVIDER_IDS.some(
      (runtimeId) => localRuntimeStatuses[runtimeId].state === 'checking'
    );
    if (isCheckingStatuses) {
      return;
    }
    const hasReachableRuntime = LOCAL_RUNTIME_PROVIDER_IDS.some((runtimeId) => {
      const state = localRuntimeStatuses[runtimeId].state;
      return state === 'available' || state === 'stale';
    });
    if (!hasReachableRuntime) {
      setLocalRuntimeModels(null);
      return;
    }

    let cancelled = false;

    void getLocalRuntimeModels()
      .then((catalog) => {
        if (!cancelled) {
          setLocalRuntimeModels(catalog);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLocalRuntimeModels(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [getLocalRuntimeModels, localRuntimeStatuses]);

  const localRuntimeHint = useMemo(() => {
    if (!localRuntimeStatuses) {
      return;
    }

    const labelByRuntime = {
      ollama: 'Ollama',
      lmstudio: 'LM Studio',
    } as const;

    const detected = (Object.keys(labelByRuntime) as Array<keyof typeof labelByRuntime>)
      .filter((runtimeId) => {
        const status = localRuntimeStatuses[runtimeId];
        return status.state === 'available' || status.state === 'stale';
      })
      .map((runtimeId) => {
        const modelState = localRuntimeModels?.[runtimeId];
        if (modelState?.state === 'loaded_non_empty' || modelState?.state === 'stale_cached') {
          return `${labelByRuntime[runtimeId]} (${modelState.models.length} models)`;
        }
        if (modelState?.state === 'loaded_empty') {
          return `${labelByRuntime[runtimeId]} (no models)`;
        }
        return labelByRuntime[runtimeId];
      });

    if (detected.length > 0) {
      return `Detected local runtime: ${detected.join(' + ')} on localhost.`;
    }

    const blockedRuntime = (Object.keys(labelByRuntime) as Array<keyof typeof labelByRuntime>).find(
      (runtimeId) => localRuntimeStatuses[runtimeId].state === 'blocked_web'
    );
    if (blockedRuntime) {
      return `${labelByRuntime[blockedRuntime]} probe was blocked by browser networking policy.`;
    }

    const checking = (Object.keys(labelByRuntime) as Array<keyof typeof labelByRuntime>).some(
      (runtimeId) => localRuntimeStatuses[runtimeId].state === 'checking'
    );
    if (checking) {
      return 'Checking local runtime availability on localhost.';
    }
    return;
  }, [localRuntimeStatuses, localRuntimeModels]);

  const shouldSkipSelectionReconcile = useCallback(
    (currentProvider: SupportedProvider | null) =>
      configuredProviders.length === 0 && !isLocalRuntimeProvider(currentProvider),
    [configuredProviders]
  );

  const hasValidCurrentModelSelection = useCallback(
    (currentProvider: SupportedProvider) =>
      hasValidProviderModelSelection({
        currentProvider,
        currentSelectedModel: getSelectedModel(),
        isModelEnabled,
      }),
    [getSelectedModel, isModelEnabled]
  );

  const handleLocalRuntimeSelection = useCallback(
    (currentProvider: SupportedProvider): boolean =>
      resolveLocalRuntimeSelection({
        currentProvider,
        currentSelectedModel: getSelectedModel(),
        isModelEnabled,
        providerHasEnabledModels,
        selectModelForProvider,
      }),
    [getSelectedModel, isModelEnabled, providerHasEnabledModels, selectModelForProvider]
  );

  // This runs before the general reconciliation effect below so the built-in
  // browser-local registry model can seed the initial local selection first.
  useEffect(() => {
    if (selectedModel !== null || !configuredProviders.includes('local')) {
      return;
    }
    const localModel = enabledBuiltInLocalModelIds[0];
    if (!(localModel && enabledModelIds.has(localModel))) {
      return;
    }
    setModel(`local::${localModel}`);
  }, [configuredProviders, enabledBuiltInLocalModelIds, enabledModelIds, selectedModel, setModel]);

  // Reconcile selection whenever providers or enabled models change
  // Using useEffect (not useLayoutEffect) because we're mutating external state (Zustand store)
  // React will properly batch these updates and handle them in the commit phase
  useEffect(() => {
    const currentProvider = getSelectedProvider();
    if (shouldSkipSelectionReconcile(currentProvider)) {
      return;
    }

    // Case 1: Current provider is no longer available
    if (currentProvider && !configuredProviders.includes(currentProvider)) {
      if (isLocalRuntimeProvider(currentProvider)) {
        return;
      }
      clearModel();
      return;
    }

    if (currentProvider && handleLocalRuntimeSelection(currentProvider)) {
      return;
    }

    // Case 2: Current provider exists and has enabled models - nothing to do
    if (
      currentProvider &&
      providerHasEnabledModels(currentProvider) &&
      hasValidCurrentModelSelection(currentProvider)
    ) {
      return;
    }

    // Case 3: Find the first provider with enabled models
    const next = findFirstProviderWithEnabledModels(configuredProviders, providerHasEnabledModels);
    if (next) {
      selectModelForProvider(next);
      return;
    }

    // Case 4: No providers with enabled models, clear selection
    if (currentProvider) {
      clearModel();
    }
  }, [
    configuredProviders,
    enabledModelIds,
    handleLocalRuntimeSelection,
    hasValidCurrentModelSelection,
    getSelectedProvider,
    clearModel,
    providerHasEnabledModels,
    selectModelForProvider,
    shouldSkipSelectionReconcile,
  ]);

  const handleModelChange = useCallback(
    (compositeKey: string) => {
      const provider = resolveProviderFromComposite(compositeKey);
      const model = resolveModelNameFromComposite(compositeKey);
      if (memoryThreadId && provider && model) {
        const draftProviderSettings = draftRuntimeByThreadId[memoryThreadId]?.providerSettings;
        const providerSettingsMap =
          copyProviderSettingsMap(draftProviderSettings) ??
          (providerSettings[provider] ? { [provider]: { ...providerSettings[provider] } } : {});
        setThreadDraftRuntime(memoryThreadId, {
          ...buildDraftRuntimeForProvider({
            model,
            provider,
            providerSettingsMap,
          }),
        });
        return;
      }
      setModel(compositeKey);
    },
    [draftRuntimeByThreadId, memoryThreadId, providerSettings, setModel, setThreadDraftRuntime]
  );

  const handleModelToggle = useCallback(
    (providerId: string, modelId: string, enabled: boolean) => {
      if (!isSupportedProvider(providerId)) {
        return;
      }

      if (isLocalRuntimeProvider(providerId)) {
        return;
      }

      // Always use database as the source of truth for model enabled state
      if (db) {
        void toggleModelInDb(db, modelId, enabled);
      }
    },
    [db, toggleModelInDb]
  );

  const handleProviderSettingsChange = useCallback(
    (providerId: string, updates: AssistantProviderSettingsUpdate) => {
      if (!isSupportedProvider(providerId)) {
        return;
      }
      if (memoryThreadId) {
        const currentDraft = draftRuntimeByThreadId[memoryThreadId] ?? {};
        const nextProviderSettings = copyProviderSettingsMap(currentDraft.providerSettings) ?? {};
        nextProviderSettings[providerId] = mergeAssistantProviderSettings(
          currentDraft.providerSettings?.[providerId] ?? providerSettings[providerId],
          updates
        );
        const draftProviderCandidate = currentDraft.provider ?? selectedProvider ?? providerId;
        const draftProvider = isSupportedProvider(draftProviderCandidate)
          ? draftProviderCandidate
          : providerId;
        const draftModel = currentDraft.model ?? resolvedModelName;
        setThreadDraftRuntime(memoryThreadId, {
          ...currentDraft,
          ...buildDraftRuntimeForProvider({
            model: draftModel,
            provider: draftProvider,
            providerSettingsMap: nextProviderSettings,
          }),
        });
        return;
      }
      setProviderSettings(providerId, updates);
    },
    [
      draftRuntimeByThreadId,
      memoryThreadId,
      providerSettings,
      resolvedModelName,
      selectedProvider,
      setProviderSettings,
      setThreadDraftRuntime,
    ]
  );

  const providerGroups = useMemo<ProviderGroupConfig[]>(() => {
    const runtimeOrder: ProviderRuntime[] = ['hosted', 'gateway', 'local', 'browser'];
    const groups = new Map<ProviderRuntime, ProviderGroupConfig>();

    runtimeOrder.forEach((runtime) => {
      groups.set(runtime, {
        runtime,
        label: RUNTIME_LABELS[runtime] ?? runtime,
        providers: [],
      });
    });

    for (const providerId of configuredProviders) {
      const definition = getProviderDefinition(providerId);
      const runtime = definition.runtime;
      const modelDefinitions = getProviderLlmModels(providerId);

      const models = modelDefinitions.map((model: LlmProviderModelDefinition) => ({
        id: model.id,
        label: model.label ?? model.id,
        type: 'llm' as const,
        enabled: isModelEnabled(providerId, model.id),
        default: Boolean(model.default),
        supportsStreaming: Boolean(model.supportsStreaming),
      }));

      const group = groups.get(runtime);
      if (!group) {
        continue;
      }

      group.providers.push({
        id: providerId,
        name: definition.displayName,
        runtime,
        capabilities: {
          ...definition.capabilities,
          supportsStandardEmbeddingDimension: supportsStandardEmbeddingDimension(providerId),
        },
        models,
      });
    }

    return runtimeOrder
      .map((runtime) => groups.get(runtime))
      .filter((group): group is ProviderGroupConfig =>
        Boolean(group && group.providers.length > 0)
      );
  }, [configuredProviders, getProviderLlmModels, isModelEnabled]);

  // Transform provider groups to ModelPicker-compatible format
  const pickerProviders = useMemo<ModelPickerProvider[]>(() => {
    return configuredProviders.map((providerId) => {
      const definition = getProviderDefinition(providerId);
      return {
        id: providerId,
        name: definition.displayName,
        icon: null, // Icons are handled by the ModelPicker's internal icon mapping
      };
    });
  }, [configuredProviders]);

  // Transform models to ModelPicker-compatible format (only enabled LLM models)
  const pickerModels = useMemo<ModelPickerModel[]>(() => {
    const models: ModelPickerModel[] = [];

    for (const providerId of configuredProviders) {
      const modelDefinitions = getProviderLlmModels(providerId);

      for (const model of modelDefinitions) {
        // Check enabled status using the unified helper
        if (!isModelEnabled(providerId, model.id)) {
          continue;
        }

        models.push({
          id: model.id,
          providerId,
          name: model.label ?? model.id,
          description: null, // LLM models don't have descriptions in the agent definitions
          capabilities: {
            type: 'llm',
            streaming: model.supportsStreaming ?? false,
          },
        });
      }
    }

    return models;
  }, [configuredProviders, getProviderLlmModels, isModelEnabled]);

  const isProviderReady = Boolean(
    selectedProvider && currentModel && configuredProviders.includes(selectedProvider)
  );
  const memoryDisabledReason = useMemo(
    () =>
      resolveAssistantMemoryDisabledReason({
        assistantThreadRepository,
        dbError,
        dbInitializing,
        desktopAssistantBackendAvailable,
        memoryLoadState,
        selectedMemoryThreadId,
        selectedProvider,
        workspaceRootPath,
      }),
    [
      assistantThreadRepository,
      dbError,
      dbInitializing,
      desktopAssistantBackendAvailable,
      memoryLoadState,
      selectedMemoryThreadId,
      selectedProvider,
      workspaceRootPath,
    ]
  );

  const providerDisabledReason = useMemo(
    () =>
      resolveAssistantProviderDisabledReason({
        configuredProviders,
        currentModel,
        getProviderLlmModels,
        localRuntimeHint,
        providerHasEnabledModels,
        selectedProvider,
      }),
    [
      configuredProviders,
      currentModel,
      getProviderLlmModels,
      localRuntimeHint,
      providerHasEnabledModels,
      selectedProvider,
    ]
  );
  const disabledReason = memoryDisabledReason ?? providerDisabledReason;

  return (
    <AssistantUiPanel
      completePreparedRequest={completePreparedRequest}
      contextMenu={contextMenu}
      onProviderSettingsChange={handleProviderSettingsChange}
      pickerModels={pickerModels}
      pickerProviders={pickerProviders}
      prepareRequestData={prepareRequestData}
      providerGroups={providerGroups}
      providerSettings={effectiveProviderSettings}
      requestData={requestData}
      toolMenu={toolMenu}
      {...(historyAdapter ? { historyAdapter } : {})}
      {...(selectedMemoryThreadId ? { threadKey: selectedMemoryThreadId } : {})}
      {...(selectedProvider ? { selectedProvider } : {})}
      {...(currentModel ? { selectedModel: currentModel } : {})}
      disabled={!isProviderReady || Boolean(memoryDisabledReason)}
      onModelChange={handleModelChange}
      onModelToggle={handleModelToggle}
      {...(disabledReason ? { disabledReason } : {})}
    />
  );
}

AssistantUiPanelWrapper.displayName = 'AssistantUiPanelWrapper';
