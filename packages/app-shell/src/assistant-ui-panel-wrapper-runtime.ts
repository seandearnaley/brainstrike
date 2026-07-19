import {
  type AnthropicProviderOptions,
  deriveEffectiveInputBudget,
  type GoogleProviderOptions,
  getLlmModelDefinition,
  type HookTrustRequest,
  type LocalProviderOptions,
  type OpenAiProviderOptions,
  type OpenRouterProviderOptions,
  type RuntimeAssistantMemorySettings,
  type RuntimeData,
} from '@brainstrike/assistant-contract';
import { getBestBuiltInLocalLlmDevice } from '@brainstrike/assistant-contract/local-llm-device';
import {
  isLoadedRuntimeModelCatalogState,
  type LocalRuntimeAvailabilityState,
  type LocalRuntimeId,
  type LocalRuntimeModelCatalogState,
} from '@brainstrike/assistant-contract/local-runtime';
import {
  DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
  DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
} from '@brainstrike/assistant-contract/memory-settings';
import {
  getProviderDefaultModel,
  getProviderDefinition,
  getProviderModelDefinitions,
  isSupportedProvider,
  type ModelVisionSupport,
  type ProviderModelDefinition,
  type SupportedProvider,
} from '@brainstrike/assistant-contract/provider-metadata';
import {
  getNativeToolDescription,
  getToolSchemaDisplay,
} from '@brainstrike/assistant-contract/tool-metadata';
import {
  type TapestryRange,
  toolLineRangeToTapestryRange,
  type useWorkspaceContextCurationStore,
} from '@brainstrike/file-explorer-ui/preview';
import type { PermissionToolGateSnapshotInput } from '@brainstrike/preferences/stores/permission-policy-store';
import {
  getGoogleThinkingLevels,
  resolveTapestryColorHex,
  type TapestryColorName,
} from '@brainstrike/types';
import type {
  AssistantProviderSettings,
  AssistantToolMenuItem,
  ComposerAttachmentsAvailability,
} from '@brainstrike/ui/assistant-ui-panel';
import type {
  AssistantThreadRepository,
  AssistantThreadRunRecord,
  AssistantThreadRuntimeKind,
} from './assistant-memory-repository';

const SUPPORTED_SEMANTIC_RECALL_EMBEDDING_PROVIDER_IDS = new Set(['openai', 'google', 'local']);

export function resolveModelNameFromComposite(
  composite: string | null | undefined
): string | undefined {
  if (!composite) {
    return;
  }
  const parts = composite.split('::');
  return parts.length === 2 ? parts[1] : composite;
}

export function resolveProviderFromComposite(
  composite: string | null | undefined
): SupportedProvider | null {
  if (!composite) {
    return null;
  }
  const parts = composite.split('::');
  const candidate = parts.length === 2 ? parts[0] : null;
  return candidate && isSupportedProvider(candidate) ? candidate : null;
}

function createThreadRunId(): string {
  return `run-${crypto.randomUUID()}`;
}

function toAssistantThreadRuntimeKind(
  runtime: AssistantThreadRuntimeKind
): AssistantThreadRuntimeKind {
  switch (runtime) {
    case 'browser':
    case 'gateway':
    case 'hosted':
    case 'local':
      return runtime;
  }
}

export function formatToolLabel(toolId: string): string {
  const name = toolId.split('.').pop() ?? toolId;
  const spaced = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .trim();
  return spaced.replace(/\b\w/g, (match) => match.toUpperCase());
}

export function getToolDescription(toolId: string): string {
  return getNativeToolDescription(toolId) ?? `Tool: ${toolId}`;
}

function resolveSemanticRecallDisabledReason(
  memorySettings: RuntimeAssistantMemorySettings
): string | undefined {
  // Observational-memory vector retrieval embeds with the SAME configured
  // semantic-recall embedder, so its requirement applies even when the
  // semantic-recall toggle itself is off.
  const observationalVectorRetrieval =
    memorySettings.observationalMemory.enabled &&
    memorySettings.observationalMemory.retrievalMode === 'vector';
  if (!(memorySettings.semanticRecall.enabled || observationalVectorRetrieval)) {
    return;
  }

  const providerId = memorySettings.semanticRecall.embeddingModelTarget?.split('/')[0]?.trim();
  if (!(providerId && SUPPORTED_SEMANTIC_RECALL_EMBEDDING_PROVIDER_IDS.has(providerId))) {
    return memorySettings.semanticRecall.enabled
      ? 'Semantic recall requires an OpenAI, Google, or built-in local embedding model. Reconfigure Assistant Memory settings.'
      : 'Semantic observation recall requires an OpenAI, Google, or built-in local embedding model. Configure one under Assistant Memory settings.';
  }
  return;
}

export function resolveAssistantMemoryDisabledReason(args: {
  assistantThreadRepository: AssistantThreadRepository | null;
  dbError: Error | null;
  dbInitializing: boolean;
  desktopAssistantBackendAvailable: boolean;
  memorySettings: RuntimeAssistantMemorySettings;
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
  const semanticRecallDisabledReason = resolveSemanticRecallDisabledReason(args.memorySettings);
  if (semanticRecallDisabledReason) {
    return semanticRecallDisabledReason;
  }
  if (!(args.selectedProvider === 'local' || args.desktopAssistantBackendAvailable)) {
    return 'Assistant memory for hosted providers requires the desktop assistant backend.';
  }
  return;
}

export function createAssistantThreadRunPromise(args: {
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
      model: args.resolvedModelName,
      provider: args.selectedProvider,
      resourceId: args.memoryResourceId,
      runtimeKind: toAssistantThreadRuntimeKind(providerDefinition.runtime),
      threadId: args.selectedMemoryThreadId,
      ...(args.modelSettings ? { modelSettings: { ...args.modelSettings } } : {}),
      ...(args.providerOptions ? { providerOptions: { ...args.providerOptions } } : {}),
    })
    .then((record: AssistantThreadRunRecord) => record.id);
}

export function buildAssistantRequestData(args: {
  agentLoopSettings: RuntimeData['agentLoop'] | undefined;
  enabledNativeToolIds: readonly string[];
  hookTrustRequest?: HookTrustRequest | undefined;
  hostedMemoryBackendAvailable: boolean;
  /**
   * The client's declared MAIN root (activeRootIds[0]) — an ordering hint for
   * the server's workspace-root enrichment; never a path, never a security
   * boundary. Attached only when a main root exists (multi-root or storage-v5
   * single-root; legacy snapshots without activeRootIds send nothing).
   */
  mainRootId?: string | undefined;
  /** Absolute path of the declared main root (server path-fallback matcher). */
  mainRootPath?: string | undefined;
  memoryOptions: RuntimeMemoryOptions;
  memoryResourceId: string | undefined;
  memorySettings: RuntimeAssistantMemorySettings;
  modelSettings: RuntimeData['modelSettings'] | undefined;
  /**
   * Serializable permission snapshot from the permission-policy store, attached
   * ONLY when the user has opted into enforcement. When absent (the default),
   * the server receives no policy and the runtime tool map is unchanged
   * (passthrough). The caller is responsible for gating this to `enforce:true`.
   */
  permissionPolicyRequest: PermissionToolGateSnapshotInput | undefined;
  /**
   * Plan mode (opt-in). Attached ONLY when `true` (presence-means-on, like
   * `permissionPolicyRequest`); the server constrains the tool map and prepends
   * the plan-mode instructions. Absent → normal run.
   */
  planMode?: boolean;
  providerOptions: Record<string, unknown> | undefined;
  selectedMemoryThreadId: string | undefined;
  selectionData: {
    filePaths: string[];
    folderId: string | null | undefined;
    otherRootsCount?: number;
  };
  workspaceContext: RuntimeData['workspaceContext'] | null;
  workspaceIndex: {
    blockedReason: RuntimeData['workspaceIndexBlockedReason'] | null;
    enabled: boolean;
    embeddingSetId: string | null;
    lastError: RuntimeData['workspaceIndexLastError'] | null;
    mode: string;
    paused: boolean;
    queueProgress: RuntimeData['workspaceIndexQueueProgress'] | null;
    statusState: RuntimeData['workspaceIndexStatusState'];
  };
  /**
   * Opt-in subagent persona availability; only set on the desktop data-stream
   * transport and only when it diverges from the defaults. A preference, not a
   * security boundary — it can only reduce the persona set.
   */
  /**
   * Opt-in Agent Skills preference; only set on the desktop data-stream
   * transport (web has no skills engine). A preference, not a security
   * boundary — it can only reduce the skill set.
   */
  skillsPreference?: RuntimeData['skillsPreference'];
  subagentPersonasRequest?: RuntimeData['subagentPersonasRequest'];
  /**
   * Opt-in workspace instructions preference; only set on the desktop
   * data-stream transport (web has no injection path). A preference, not a
   * security boundary — the server reads it directly.
   */
  workspaceInstructionsPreference?: RuntimeData['workspaceInstructionsPreference'];
  workspaceRootPath: string | null;
}): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (args.selectionData.filePaths.length > 0) {
    data['selectionFilePaths'] = args.selectionData.filePaths;
  }
  if (args.selectionData.folderId) {
    data['selectionFolderId'] = args.selectionData.folderId;
  }
  if ((args.selectionData.otherRootsCount ?? 0) > 0) {
    // Multi-root: files selected in OTHER active roots are not addressable
    // by the single-root assistant workspace — surface the count, never
    // silently drop them.
    data['selectionFilePathsFromOtherRoots'] = args.selectionData.otherRootsCount;
  }
  if (args.workspaceRootPath) {
    data['workspaceRootPath'] = args.workspaceRootPath;
  }
  // MAIN root declaration (multi-root): ordering hint for the server's root
  // enrichment. Distinct from workspaceRootPath above, which stays the
  // FOCUSED root (selection scope).
  if (args.mainRootId) {
    data['mainRootId'] = args.mainRootId;
  }
  if (args.mainRootPath) {
    data['mainRootPath'] = args.mainRootPath;
  }
  data['enabledNativeToolIds'] = Array.from(args.enabledNativeToolIds);
  if (args.workspaceContext) {
    data['workspaceContext'] = args.workspaceContext;
  }
  if (args.workspaceIndex.embeddingSetId) {
    data['workspaceIndexEmbeddingSetId'] = args.workspaceIndex.embeddingSetId;
  }
  data['workspaceIndexingEnabled'] = args.workspaceIndex.enabled;
  data['workspaceIndexingMode'] = args.workspaceIndex.mode;
  data['workspaceIndexingPaused'] = args.workspaceIndex.paused;
  data['workspaceIndexStatusState'] = args.workspaceIndex.statusState;
  if (args.workspaceIndex.blockedReason) {
    data['workspaceIndexBlockedReason'] = args.workspaceIndex.blockedReason;
  }
  if (args.workspaceIndex.lastError) {
    data['workspaceIndexLastError'] = args.workspaceIndex.lastError;
  }
  if (args.workspaceIndex.queueProgress) {
    data['workspaceIndexQueueProgress'] = {
      failed: args.workspaceIndex.queueProgress.failed,
      pending: args.workspaceIndex.queueProgress.pending,
      processed: args.workspaceIndex.queueProgress.processed,
      totalQueued: args.workspaceIndex.queueProgress.totalQueued,
      ...(args.workspaceIndex.queueProgress.lastError
        ? { lastError: args.workspaceIndex.queueProgress.lastError }
        : {}),
    };
  }
  if (args.memoryResourceId && args.selectedMemoryThreadId && args.hostedMemoryBackendAvailable) {
    data['memory'] = {
      memoryOptions: args.memoryOptions,
      memorySettings: args.memorySettings,
      resourceId: args.memoryResourceId,
      threadId: args.selectedMemoryThreadId,
    };
  }
  if (args.agentLoopSettings) {
    data['agentLoop'] = args.agentLoopSettings;
  }
  if (args.modelSettings) {
    data['modelSettings'] = args.modelSettings;
  }
  if (args.providerOptions) {
    data['providerOptions'] = args.providerOptions;
  }
  attachOptInRequestFields(data, args);
  return data;
}

interface OptInRequestFields {
  hookTrustRequest?: HookTrustRequest | undefined;
  permissionPolicyRequest?: PermissionToolGateSnapshotInput | undefined;
  planMode?: boolean;
  skillsPreference?: RuntimeData['skillsPreference'];
  subagentPersonasRequest?: RuntimeData['subagentPersonasRequest'];
  workspaceInstructionsPreference?: RuntimeData['workspaceInstructionsPreference'];
}

/**
 * Attach the OPT-IN / presence-means-on request fields (all desktop
 * data-stream-gated by the caller). Extracted so `buildAssistantRequestData`
 * stays under the cognitive-complexity budget.
 */
function attachOptInRequestFields(data: Record<string, unknown>, fields: OptInRequestFields): void {
  // Permission enforcement is OPT-IN: presence means "enforce"; the server
  // re-checks `enforce` and adds server-owned tool risk classification.
  if (fields.permissionPolicyRequest) {
    data['permissionPolicyRequest'] = fields.permissionPolicyRequest;
  }
  // Hook-trust attestation: only on the data-stream transport; server re-hashes disk.
  if (fields.hookTrustRequest) {
    data['hookTrustRequest'] = fields.hookTrustRequest;
  }
  // Plan mode is presence-means-on: only send `true`, never a `false` residue.
  if (fields.planMode) {
    data['planMode'] = true;
  }
  // Workspace instructions preference: absent => server default (master on).
  // Subagent persona availability is presence-means-non-default: the builder
  // returns undefined at the defaults, so nothing rides the wire then.
  if (fields.subagentPersonasRequest) {
    data['subagentPersonasRequest'] = fields.subagentPersonasRequest;
  }
  if (fields.workspaceInstructionsPreference) {
    data['workspaceInstructionsPreference'] = fields.workspaceInstructionsPreference;
  }
  // Skills preference: absent => server default (master on, nothing disabled).
  if (fields.skillsPreference) {
    data['skillsPreference'] = fields.skillsPreference;
  }
}

function getAssistantTapestryColor(key: string): string {
  const palette = ['#2563eb', '#059669', '#dc2626', '#7c3aed', '#d97706', '#0891b2'];
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return palette[hash % palette.length] ?? '#2563eb';
}

export function buildAssistantTapestryRange(args: {
  color?: TapestryColorName;
  compositeKey: string;
  endLine: number;
  index: number;
  isActive: boolean | undefined;
  startLine: number;
}): TapestryRange {
  const internalRange = toolLineRangeToTapestryRange({
    endLine: args.endLine,
    startLine: args.startLine,
  });
  const rangeKey = `${args.compositeKey}:${args.index}:${args.startLine}:${args.endLine}`;
  return {
    color: resolveTapestryColorHex(args.color) ?? getAssistantTapestryColor(rangeKey),
    endLine: internalRange.endLine,
    id: `assistant-${rangeKey}`,
    isActive: args.isActive !== false,
    startLine: internalRange.startLine,
    userModified: true,
  };
}

export function toRuntimeWorkspaceContext(
  snapshot: ReturnType<typeof useWorkspaceContextCurationStore.getState>['contextSnapshot'],
  selectionFolderId: string | null | undefined
): RuntimeData['workspaceContext'] | null {
  if (!snapshot) {
    return null;
  }
  if (snapshot.selectionFolderId && snapshot.selectionFolderId !== selectionFolderId) {
    return null;
  }
  return {
    files: snapshot.files,
    includeProjectTree: snapshot.includeProjectTree,
    projectTreeApproxTokens: snapshot.projectTreeApproxTokens,
    projectTreeTokenCountLoading: snapshot.projectTreeTokenCountLoading,
    selectedOutputApproxTokens: snapshot.selectedOutputApproxTokens,
    selectedSourceApproxTokens: snapshot.selectedSourceApproxTokens,
    ...(snapshot.tokenBudget === null ? {} : { tokenBudget: snapshot.tokenBudget }),
  };
}

export function resolveAssistantProviderDisabledReason(args: {
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
    providerModelIds,
    selectedModel: args.currentModel ?? null,
    selectedProvider: args.selectedProvider,
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

export function resolveProviderModelSelection(args: {
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

export function hasValidProviderModelSelection(args: {
  currentProvider: SupportedProvider;
  currentSelectedModel: string | null;
  isModelEnabled: (providerId: SupportedProvider, modelId: string) => boolean;
  providerModelIds: readonly string[];
}): boolean {
  const currentModelName = resolveModelNameFromComposite(args.currentSelectedModel);
  if (!(currentModelName && args.providerModelIds.includes(currentModelName))) {
    return false;
  }
  return args.isModelEnabled(args.currentProvider, currentModelName);
}

export function resolveLocalRuntimeSelection(args: {
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

export type LocalRuntimeStatusMap = Record<LocalRuntimeId, LocalRuntimeAvailabilityState>;
export type LocalRuntimeModelCatalogMap = Partial<
  Record<LocalRuntimeId, LocalRuntimeModelCatalogState>
>;
export type LlmProviderModelDefinition = ProviderModelDefinition & { type: 'llm' };

export const LOCAL_RUNTIME_PROVIDER_IDS = ['ollama', 'lmstudio'] as const;
export type LocalRuntimeProviderId = (typeof LOCAL_RUNTIME_PROVIDER_IDS)[number];

export function isLocalRuntimeProvider(
  providerId: SupportedProvider | null | undefined
): providerId is LocalRuntimeProviderId {
  if (!providerId) {
    return false;
  }
  return LOCAL_RUNTIME_PROVIDER_IDS.includes(providerId as LocalRuntimeProviderId);
}

export function toRuntimeProviderModels(
  providerId: LocalRuntimeProviderId,
  catalog: LocalRuntimeModelCatalogMap | null
): readonly LlmProviderModelDefinition[] {
  const runtimeState = catalog?.[providerId];
  if (!isLoadedRuntimeModelCatalogState(runtimeState)) {
    return [];
  }

  const llmCandidates = runtimeState.models.filter((model) => model.capabilities.llm);
  return llmCandidates.map((model, index) => ({
    // Conservative floor: user-supplied local models don't declare their context window.
    // This intentionally under-budgets large models (a 128k model gets a 32k budget — safe).
    // For small models (e.g. a 4k-context quantized GGUF) it over-estimates: the agent may
    // compose prompts larger than the model holds. Accepted tradeoff — the local server's
    // own context cap is the real enforcement on that path.
    contextWindow: 32_768,
    default: index === 0,
    id: model.modelId,
    label: model.displayName,
    supportsStreaming: true,
    type: 'llm' as const,
    vision: model.capabilities.vision,
  }));
}

/**
 * Composer image-attachment gate. Layered on top of the provider predicate
 * (every hosted provider is eligible — the desktop assistant server and the
 * web /api/assistant route share the same image-aware conversion; only the
 * text-only built-in local provider is excluded): when that gate fails the
 * affordance is hidden entirely (undefined); when it passes, the SELECTED
 * MODEL's vision capability decides between 'enabled' and a visibly
 * 'disabled' button carrying the reason — never a silent hide. 'unknown'
 * vision (runtime-discovered model without a capability signal) and an
 * unresolved definition (e.g. runtime catalog still loading) stay
 * optimistic: a wrong guess surfaces as a visible provider error downstream,
 * whereas guessing 'unsupported' would silently block a capable model.
 */
export function resolveComposerAttachmentsAvailability(args: {
  readonly providerGateAvailable: boolean;
  readonly selectedModel:
    | {
        readonly id: string;
        readonly label?: string | undefined;
        readonly vision: ModelVisionSupport;
      }
    | undefined;
}): ComposerAttachmentsAvailability | undefined {
  if (!args.providerGateAvailable) {
    return;
  }
  if (args.selectedModel?.vision === 'unsupported') {
    const modelName = args.selectedModel.label ?? args.selectedModel.id;
    return {
      reason: `${modelName} doesn't support image input. Switch to a vision-capable model to attach images.`,
      state: 'disabled',
    };
  }
  return { state: 'enabled' };
}

/**
 * True when the ACTIVE turn's transport can ever deliver a context-breakdown
 * data part (review fix, context-ring WS8). `AssistantUiPanel` routes a
 * turn through `LocalRuntimeChat` — the in-renderer local runtime, which
 * structurally has no breakdown channel — only when the provider is `'local'`
 * AND `localChatTransport !== 'data-stream'` (web's built-in local provider;
 * desktop's built-in local provider instead routes through the assistant
 * server's data-stream transport, which DOES forward `onContextBreakdown`).
 * Every other combination uses `DataStreamRuntimeChat`, which always forwards
 * it. Callers use this to clear a thread's stale breakdown when a
 * capability-absent local turn updates usage without ever refreshing it —
 * otherwise the popover keeps showing an earlier hosted turn's breakdown rows
 * next to the local turn's freshly updated totals.
 */
export function hasContextBreakdownChannel(
  selectedProvider: SupportedProvider | null,
  localChatTransport: 'data-stream' | 'local-runtime'
): boolean {
  return !(selectedProvider === 'local' && localChatTransport !== 'data-stream');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function addValuesToSet(target: Set<string>, values: Iterable<string>): void {
  for (const value of values) {
    if (isNonEmptyString(value)) {
      target.add(value);
    }
  }
}

export function getBuiltInLocalPreferenceModelIds(
  enabledModelsByProvider: Record<SupportedProvider, string[]>
): string[] {
  return (enabledModelsByProvider.local ?? []).filter(isNonEmptyString);
}

// Browser-local models are DB-backed in the split assistant chunk; the registry id is the
// authoritative runtime id when static provider metadata has not produced a usable id yet.
export function getEnabledBuiltInLocalRegistryModelIds(
  downloadedModels: Readonly<Record<string, boolean>>,
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
      isNonEmptyString(model.id) &&
      downloadedModels[model.id] === true
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

export function buildEnabledModelIdSet(options: {
  readonly shouldFallbackToPreferences: boolean;
  readonly configuredProviders: readonly SupportedProvider[];
  readonly enabledModelsByProvider: Record<SupportedProvider, string[]>;
  readonly fixedProviderModels?: FixedProviderModels | undefined;
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

  if (!options.shouldFallbackToPreferences) {
    addBuiltInLocalPreferenceModelIds(
      enabledIds,
      options.configuredProviders,
      options.enabledModelsByProvider
    );
  }
  addRuntimeCatalogEnabledLlmModelIds(enabledIds, options.localRuntimeModels);
  for (const modelIds of Object.values(options.fixedProviderModels ?? {})) {
    addValuesToSet(enabledIds, modelIds ?? []);
  }
  return enabledIds;
}

export type FixedProviderModels = Partial<Record<SupportedProvider, readonly string[]>>;

export function resolveFixedProviderModelSelection(args: {
  currentModel: string | null | undefined;
  fixedProviderModels: FixedProviderModels | undefined;
}): string | undefined {
  if (!args.fixedProviderModels) {
    return;
  }
  const currentProvider = resolveProviderFromComposite(args.currentModel);
  const currentModelName = resolveModelNameFromComposite(args.currentModel);
  if (
    currentProvider &&
    currentModelName &&
    args.fixedProviderModels[currentProvider]?.includes(currentModelName)
  ) {
    return `${currentProvider}::${currentModelName}`;
  }
  for (const [provider, models] of Object.entries(args.fixedProviderModels)) {
    const model = models?.[0];
    if (model && isSupportedProvider(provider)) {
      return `${provider}::${model}`;
    }
  }
  return;
}

export function getRuntimeProviderLlmModels(
  provider: SupportedProvider,
  runtimeModels: Partial<Record<LocalRuntimeProviderId, readonly LlmProviderModelDefinition[]>>,
  fixedModels: readonly string[] | undefined
): readonly LlmProviderModelDefinition[] {
  if (isLocalRuntimeProvider(provider)) {
    return runtimeModels[provider] ?? [];
  }
  const modelDefinitions = getProviderModelDefinitions(provider).filter(
    (model): model is LlmProviderModelDefinition => model.type === 'llm'
  );
  if (!fixedModels) {
    return modelDefinitions;
  }
  const fixedModelIds = new Set(fixedModels);
  return modelDefinitions.filter((model) => fixedModelIds.has(model.id));
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
  if (getBestBuiltInLocalLlmDevice() !== 'webgpu') {
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

export function findFirstProviderWithEnabledModels(
  configuredProviders: readonly SupportedProvider[],
  providerHasEnabledModels: (provider: SupportedProvider) => boolean
): SupportedProvider | undefined {
  return configuredProviders.find((providerId) => providerHasEnabledModels(providerId));
}

interface McpToolDescriptor {
  description?: string;
  enabled: boolean;
  id: string;
  inputSchema?: unknown;
}

export type McpToolMap = Record<string, McpToolDescriptor[]>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function toLocalRuntimeInputSchema(toolId: string): Record<string, unknown> | undefined {
  const displaySchema = getToolSchemaDisplay(toolId);
  if (!displaySchema) {
    return;
  }

  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  for (const parameter of displaySchema.parameters) {
    const schema: Record<string, unknown> = {
      description: parameter.description,
      type: parameter.type === 'enum' ? 'string' : parameter.type,
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
    properties,
    type: 'object',
    ...(required.length > 0 ? { required } : {}),
  };
}

export function buildMcpMenuItems(toolsByServer: McpToolMap): AssistantToolMenuItem[] {
  const items: AssistantToolMenuItem[] = [];
  for (const [serverName, serverTools] of Object.entries(toolsByServer)) {
    for (const tool of serverTools) {
      items.push({
        category: 'action',
        description: tool.description ?? `MCP tool: ${tool.id}`,
        enabled: tool.enabled,
        group: serverName,
        id: tool.id,
        label: formatToolLabel(tool.id),
        source: 'mcp',
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

export type RuntimeMemoryOptions = NonNullable<RuntimeData['memory']>['memoryOptions'];

export function buildModelSettings(
  settings: AssistantProviderSettings | undefined
): RuntimeData['modelSettings'] | undefined {
  if (!settings || typeof settings.maxOutputTokens !== 'number') {
    return;
  }
  const value = Math.max(1, Math.floor(settings.maxOutputTokens));
  return Number.isFinite(value) ? { maxOutputTokens: value } : undefined;
}

function buildPositiveIntegerSetting(value: unknown): number | undefined {
  if (typeof value !== 'number') {
    return;
  }
  const normalized = Math.floor(value);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : undefined;
}

function buildNonNegativeIntegerSetting(value: unknown): number | undefined {
  if (typeof value !== 'number') {
    return;
  }
  const normalized = Math.floor(value);
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : undefined;
}

/**
 * Minimal model definition shape needed for input-budget derivation.
 * Matches the required fields on both LlmModelDefinition (static registry)
 * and the synthesised LlmProviderModelDefinition returned by toRuntimeProviderModels
 * (dynamic ollama/lmstudio models), so callers can pass either without a re-lookup.
 */
export interface SelectedModelBudgetDef {
  contextWindow: number;
  maxOutputTokens?: number;
}

export function buildAgentLoopSettings(
  settings: AssistantProviderSettings | undefined,
  selectedModelDef?: SelectedModelBudgetDef
): RuntimeData['agentLoop'] | undefined {
  const maxSteps = buildPositiveIntegerSetting(settings?.agentMaxSteps);
  let inputTokenLimit = buildPositiveIntegerSetting(settings?.agentInputTokenLimit);
  if (inputTokenLimit === undefined && selectedModelDef !== undefined) {
    inputTokenLimit = deriveEffectiveInputBudget(
      selectedModelDef.contextWindow,
      selectedModelDef.maxOutputTokens
    );
  }
  if (!(maxSteps || inputTokenLimit)) {
    return;
  }
  return {
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(inputTokenLimit === undefined ? {} : { inputTokenLimit }),
  };
}

export function buildAssistantMemoryOptions(
  settings: AssistantProviderSettings | undefined
): RuntimeMemoryOptions {
  const configuredLastMessages = buildNonNegativeIntegerSetting(settings?.memoryLastMessages);
  const lastMessages =
    configuredLastMessages === undefined
      ? DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES
      : configuredLastMessages === 0
        ? false
        : configuredLastMessages;
  return {
    lastMessages,
    workingMemory: {
      ...DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
      enabled: settings?.workingMemoryEnabled ?? DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY.enabled,
    },
  };
}

function resolveGoogleThinkingLevel(
  modelName: string | undefined,
  value: AssistantProviderSettings['googleThinkingLevel']
): AssistantProviderSettings['googleThinkingLevel'] {
  if (!value) {
    return;
  }
  // Shared helper keeps this in sync with the settings UI's level options so a
  // Pro model never offers a level the runtime would silently drop here.
  return getGoogleThinkingLevels(modelName).includes(value) ? value : undefined;
}

function buildOpenAiOptions(
  settings: AssistantProviderSettings
): OpenAiProviderOptions | undefined {
  return buildOptionalOptions<OpenAiProviderOptions>([
    ['reasoningEffort', settings.reasoningEffort || undefined],
    ['reasoningSummary', settings.reasoningSummary || undefined],
  ]);
}

function buildOpenRouterOptions(
  modelName: string | undefined,
  settings: AssistantProviderSettings
): OpenRouterProviderOptions | undefined {
  const reasoningEffort = settings.reasoningEffort;
  if (modelName && reasoningEffort) {
    const model = getLlmModelDefinition('openrouter', modelName);
    if (!model.reasoning) {
      throw new Error(
        `OpenRouter model "${model.label ?? model.id}" does not declare support for reasoning effort "${reasoningEffort}".`
      );
    }
    if (!model.reasoning.supportedEfforts.includes(reasoningEffort)) {
      throw new Error(
        `OpenRouter model "${model.label ?? model.id}" does not support reasoning effort "${reasoningEffort}". Supported efforts: ${model.reasoning.supportedEfforts.join(', ')}.`
      );
    }
  }
  const reasoning = buildOptionalOptions<NonNullable<OpenRouterProviderOptions['reasoning']>>([
    ['effort', reasoningEffort || undefined],
    ['summary', settings.reasoningSummary || undefined],
  ]);
  return reasoning ? { reasoning } : undefined;
}

function buildAnthropicOptions(
  settings: AssistantProviderSettings
): AnthropicProviderOptions | undefined {
  const thinking =
    typeof settings.anthropicThinkingBudgetTokens === 'number'
      ? {
          budgetTokens: Math.floor(settings.anthropicThinkingBudgetTokens),
          type: 'enabled' as const,
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

export function buildProviderOptions(
  providerId: SupportedProvider | null,
  modelName: string | undefined,
  settings: AssistantProviderSettings | undefined
): RuntimeData['providerOptions'] | undefined {
  if (!(providerId && settings)) {
    return;
  }

  switch (providerId) {
    case 'openai': {
      const openai = buildOpenAiOptions(settings);
      return openai ? { openai } : undefined;
    }
    case 'openrouter': {
      const openrouter = buildOpenRouterOptions(modelName, settings);
      return openrouter ? { openrouter } : undefined;
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

/**
 * Clear a provider-wide effort override when the user explicitly switches to
 * an OpenRouter model that rejects it or has no declared effort support. The
 * model's documented default then remains visible as "Auto" in the settings
 * control; request construction still throws if incompatible state reaches it
 * by any other path.
 */
export function reconcileProviderSettingsForModel(
  providerId: SupportedProvider,
  modelName: string,
  settings: AssistantProviderSettings | undefined
): AssistantProviderSettings | undefined {
  if (!(providerId === 'openrouter' && settings?.reasoningEffort)) {
    return settings;
  }
  const model = getLlmModelDefinition('openrouter', modelName);
  if (model.reasoning?.supportedEfforts.includes(settings.reasoningEffort)) {
    return settings;
  }
  const { reasoningEffort: _unsupportedReasoningEffort, ...compatibleSettings } = settings;
  return compatibleSettings;
}

export function copyProviderSettingsMap(
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

export function extractPreparedRunId(
  requestData: Record<string, unknown> | undefined
): string | null {
  const memory = requestData?.['memory'];
  if (!(memory && typeof memory === 'object' && !Array.isArray(memory))) {
    return null;
  }
  const runId = (memory as Record<string, unknown>)['runId'];
  return typeof runId === 'string' && runId.trim() ? runId : null;
}

export function buildDraftRuntimeForProvider({
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

export interface McpState {
  loading: boolean;
  tools: AssistantToolMenuItem[];
}

export type McpAction =
  | { type: 'LOADING' }
  | { type: 'LOADED'; tools: AssistantToolMenuItem[] }
  | { type: 'ERROR' };

export function mcpReducer(_state: McpState, action: McpAction): McpState {
  switch (action.type) {
    case 'LOADING':
      return { loading: true, tools: [] };
    case 'LOADED':
      return { loading: false, tools: action.tools };
    case 'ERROR':
      return { loading: false, tools: [] };
  }
}
