import {
  type AnthropicProviderOptions,
  BEDROCK_BUDGET_TOKENS_BY_EFFORT,
  BEDROCK_REASONING_EFFORTS,
  type BedrockProviderOptions,
  DESKTOP_NATIVE_TOOL_IDS,
  type DesktopNativeToolId,
  DYNAMIC_LOCAL_MODEL_CONTEXT_WINDOW,
  deriveEffectiveInputBudget,
  findLlmModelDefinition,
  type GoogleProviderOptions,
  getLlmModelDefinition,
  type HookTrustRequest,
  LOCAL_DESKTOP_NATIVE_TOOL_IDS,
  type LocalProviderOptions,
  listProviderLlmModels,
  mergeOpenRouterAutoProfileModel,
  type OpenAiProviderOptions,
  type OpenRouterAutoProfileModel,
  type OpenRouterModelMetadata,
  type OpenRouterModelMetadataLookup,
  type OpenRouterProviderOptions,
  type ProviderKeySource,
  type RuntimeAssistantMemorySettings,
  type RuntimeData,
  resolveBedrockReasoningDisplay,
  resolveOpenRouterAutoRuntimeProfile,
  resolveOpenRouterCodingMaxOutputTokens,
  resolveOpenRouterOutputWindow,
  resolveOpenRouterReasoningActive,
  resolveReasoningVisible,
  WEB_NATIVE_TOOL_IDS,
} from '@brainstrike/assistant-contract';
import { readChildFollowupRunConfigAction } from '@brainstrike/assistant-contract/child-followup';
import { getBestBuiltInLocalLlmDevice } from '@brainstrike/assistant-contract/local-llm-device';
import {
  DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
  DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
  listAutoObservationalMemoryCandidates,
  OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET,
  type RuntimeAssistantObservationalMemorySettings,
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
import type { RuntimeSubagentSettings } from '@brainstrike/assistant-contract/subagent-settings';
import { readToolApprovalRunConfigAction } from '@brainstrike/assistant-contract/tool-approval';
import {
  getNativeToolDescription,
  getToolSchemaDisplay,
} from '@brainstrike/assistant-contract/tool-metadata';
import { readToolResumeRunConfigAction } from '@brainstrike/assistant-contract/tool-suspend';
import type {
  AssistantThreadMetadata,
  AssistantThreadRepository,
  AssistantThreadRunRecord,
  AssistantThreadRuntimeKind,
} from '@brainstrike/assistant-data';
import type {
  AssistantProviderSettings,
  AssistantToolMenuItem,
  ComposerAttachmentsAvailability,
} from '@brainstrike/assistant-ui';
import {
  type TapestryRange,
  toolLineRangeToTapestryRange,
  type useWorkspaceContextCurationStore,
} from '@brainstrike/file-explorer-ui/preview';
import {
  isLoadedRuntimeModelCatalogState,
  type LocalRuntimeAvailabilityState,
  type LocalRuntimeId,
  type LocalRuntimeModelCatalogState,
} from '@brainstrike/local-runtime';
import {
  getGoogleThinkingLevels,
  resolveTapestryColorHex,
  type TapestryColorName,
} from '@brainstrike/types';

const SUPPORTED_SEMANTIC_RECALL_EMBEDDING_PROVIDER_IDS = new Set(['openai', 'google', 'local']);
const SUPPORTED_OBSERVATIONAL_MEMORY_PROVIDER_IDS = new Set([
  'openai',
  'anthropic',
  'google',
  'openrouter',
  'local',
]);

export interface AssistantOperatingRootBinding {
  readonly displayName: string;
  readonly path?: string | undefined;
  readonly persisted: boolean;
  readonly rootId: string;
}

export function resolveAssistantOperatingRootBinding(args: {
  readonly currentMainRoot?: Omit<AssistantOperatingRootBinding, 'persisted'> | undefined;
  readonly threadMetadata?: AssistantThreadMetadata | undefined;
}): AssistantOperatingRootBinding | undefined {
  const metadata = args.threadMetadata;
  const hasPersistedRootMetadata = Boolean(
    metadata?.operatingRootId || metadata?.operatingRootDisplayName || metadata?.operatingRootPath
  );
  if (
    hasPersistedRootMetadata &&
    !(metadata?.operatingRootId && metadata.operatingRootDisplayName)
  ) {
    throw new Error('Assistant thread operating-root metadata is incomplete.');
  }
  if (metadata?.operatingRootId && metadata.operatingRootDisplayName) {
    return {
      displayName: metadata.operatingRootDisplayName,
      ...(metadata.operatingRootPath ? { path: metadata.operatingRootPath } : {}),
      persisted: true,
      rootId: metadata.operatingRootId,
    };
  }
  return args.currentMainRoot ? { ...args.currentMainRoot, persisted: false } : undefined;
}

export function resolveAdvertisedNativeToolIds(args: {
  desktopBridgeAvailable: boolean;
  selectedProvider: SupportedProvider | null;
}): readonly DesktopNativeToolId[] {
  if (!args.desktopBridgeAvailable) {
    return WEB_NATIVE_TOOL_IDS;
  }
  if (args.selectedProvider === 'local') {
    return LOCAL_DESKTOP_NATIVE_TOOL_IDS;
  }
  return DESKTOP_NATIVE_TOOL_IDS;
}

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

function resolveSemanticRecallDisabledReason(args: {
  memorySettings: RuntimeAssistantMemorySettings;
  providerKeySources: readonly ProviderKeySource<SupportedProvider>[] | undefined;
  providerReadErrors: Partial<Record<SupportedProvider, string>> | undefined;
}): string | undefined {
  // Observational-memory vector retrieval embeds with the SAME configured
  // semantic-recall embedder, so its requirement applies even when the
  // semantic-recall toggle itself is off.
  const observationalVectorRetrieval =
    args.memorySettings.observationalMemory.enabled &&
    args.memorySettings.observationalMemory.retrievalMode === 'vector';
  if (!(args.memorySettings.semanticRecall.enabled || observationalVectorRetrieval)) {
    return;
  }

  const providerId = args.memorySettings.semanticRecall.embeddingModelTarget?.split('/')[0]?.trim();
  if (
    !(
      providerId &&
      isSupportedProvider(providerId) &&
      SUPPORTED_SEMANTIC_RECALL_EMBEDDING_PROVIDER_IDS.has(providerId)
    )
  ) {
    return args.memorySettings.semanticRecall.enabled
      ? 'Semantic recall requires an OpenAI, Google, or built-in local embedding model. Reconfigure Assistant Memory settings.'
      : 'Semantic observation recall requires an OpenAI, Google, or built-in local embedding model. Configure one under Assistant Memory settings.';
  }
  const providerReadError = args.providerReadErrors?.[providerId];
  if (providerReadError) {
    return providerReadError;
  }
  if (
    providerId === 'local' ||
    args.providerKeySources === undefined ||
    args.providerKeySources.some(({ provider }) => provider === providerId)
  ) {
    return;
  }

  const providerName = getProviderDefinition(providerId).displayName;
  return args.memorySettings.semanticRecall.enabled
    ? `Semantic recall requires a configured ${providerName} API key. Configure it in Settings → Providers, choose a keyless local embedder, or turn semantic recall off.`
    : `Semantic observation recall requires a configured ${providerName} API key. Configure it in Settings → Providers, choose a keyless local embedder, or turn vector observation retrieval off.`;
}

/** Why an 'auto' observer target could not resolve to a concrete model. */
export type ObservationalMemoryAutoUnresolvedReason =
  | 'keys-unknown'
  | 'model-not-eligible'
  | 'no-backend'
  | 'no-hosted-chat-provider';

export interface EffectiveObservationalMemorySettings {
  /**
   * Present ONLY when the stored target was the 'auto' sentinel. 'resolved'
   * carries the concrete target auto picked; 'unresolved' explains why OM is
   * waiting (surfaced in Settings and the context popover — never a silent
   * off, and never a thread-memory-disabling validation error).
   */
  readonly autoResolution?:
    | { readonly kind: 'resolved'; readonly target: string }
    | { readonly kind: 'unresolved'; readonly reason: ObservationalMemoryAutoUnresolvedReason };
  readonly settings: RuntimeAssistantObservationalMemorySettings;
}

/**
 * Resolve the stored observational-memory settings into the CONCRETE settings
 * every downstream consumer uses (request data, memory validation, OM meter).
 *
 * The 'auto' sentinel adapts to the profile under the PRIVACY INVARIANT
 * (review ruling on BST-940): the observer is only ever a Mastra-tested fast
 * model from the SELECTED CHAT PROVIDER — the party already receiving the
 * conversation. A local/keyless chat, an unkeyed hosted chat, or a candidate
 * disabled in the user's model catalog (isTargetEligible) flips enabled→false
 * with an explicit unresolved reason instead. Explicit (non-auto) targets pass
 * through untouched so misconfiguration keeps its loud validation. 'auto' must
 * never reach the provider/model validator.
 */
export function resolveEffectiveObservationalMemorySettings(args: {
  readonly desktopAssistantBackendAvailable: boolean;
  /**
   * Model-catalog eligibility for a resolved candidate (provider enabled +
   * model enabled, same gate as the settings dropdown). Omit while the
   * registry has not loaded — the key/chat-provider gates still apply.
   */
  readonly isTargetEligible?: (target: {
    readonly modelId: string;
    readonly provider: string;
  }) => boolean;
  readonly providerKeySources: readonly ProviderKeySource<SupportedProvider>[] | undefined;
  readonly selectedChatProvider: string | null | undefined;
  readonly settings: RuntimeAssistantObservationalMemorySettings;
}): EffectiveObservationalMemorySettings {
  if (args.settings.modelTarget !== OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET) {
    return { settings: args.settings };
  }
  const unresolved = (
    reason: ObservationalMemoryAutoUnresolvedReason
  ): EffectiveObservationalMemorySettings => ({
    autoResolution: { kind: 'unresolved', reason },
    settings: { ...args.settings, enabled: false },
  });
  if (!args.desktopAssistantBackendAvailable) {
    return unresolved('no-backend');
  }
  if (args.providerKeySources === undefined) {
    return unresolved('keys-unknown');
  }
  const candidates = listAutoObservationalMemoryCandidates({
    chatProvider: args.selectedChatProvider,
    providersWithKeys: args.providerKeySources.map(({ provider }) => provider),
  });
  if (candidates.length === 0) {
    return unresolved('no-hosted-chat-provider');
  }
  // First catalog-eligible candidate wins (candidate order is the Mastra
  // grounding; e.g. OpenRouter's preferred Gemini targets ship
  // catalog-disabled, so the fallbacks matter). No predicate → registry not
  // loaded yet → first candidate, key/chat-provider gates already applied.
  const target = args.isTargetEligible
    ? candidates.find((candidate) => {
        const separatorIndex = candidate.indexOf('/');
        return args.isTargetEligible?.({
          modelId: candidate.slice(separatorIndex + 1),
          provider: candidate.slice(0, separatorIndex),
        });
      })
    : candidates[0];
  if (target === undefined) {
    return unresolved('model-not-eligible');
  }
  return {
    autoResolution: { kind: 'resolved', target },
    settings: { ...args.settings, modelTarget: target },
  };
}

function resolveObservationalMemoryDisabledReason(args: {
  desktopAssistantBackendAvailable: boolean;
  memorySettings: RuntimeAssistantMemorySettings;
  providerKeySources: readonly ProviderKeySource<SupportedProvider>[] | undefined;
  providerReadErrors: Partial<Record<SupportedProvider, string>> | undefined;
  selectedProvider: SupportedProvider | null;
}): string | undefined {
  // Defense in depth: resolve the 'auto' sentinel with the SAME deterministic
  // rules the wrapper uses, so a caller passing raw stored settings can never
  // turn an unresolved auto observer into a memory-disabling validation error.
  const { settings: observationalMemory } = resolveEffectiveObservationalMemorySettings({
    desktopAssistantBackendAvailable: args.desktopAssistantBackendAvailable,
    providerKeySources: args.providerKeySources,
    selectedChatProvider: args.selectedProvider,
    settings: args.memorySettings.observationalMemory,
  });
  if (!observationalMemory.enabled) {
    return;
  }
  if (!args.desktopAssistantBackendAvailable) {
    return 'Observational memory requires the desktop assistant backend.';
  }

  const modelTarget = observationalMemory.modelTarget;
  const separatorIndex = modelTarget.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === modelTarget.length - 1) {
    return 'Observational memory requires a valid provider/model target. Reconfigure Assistant Memory settings.';
  }

  const providerId = modelTarget.slice(0, separatorIndex);
  if (
    !(
      isSupportedProvider(providerId) && SUPPORTED_OBSERVATIONAL_MEMORY_PROVIDER_IDS.has(providerId)
    )
  ) {
    return `Observational memory model target ${modelTarget} uses an unsupported provider. Reconfigure Assistant Memory settings.`;
  }
  const providerReadError = args.providerReadErrors?.[providerId];
  if (providerReadError) {
    return providerReadError;
  }
  if (providerId === 'local') {
    return;
  }
  if (args.providerKeySources === undefined) {
    return;
  }
  if (args.providerKeySources.some(({ provider }) => provider === providerId)) {
    return;
  }

  const providerName = getProviderDefinition(providerId).displayName;
  return `Observational memory requires a configured ${providerName} API key. Configure it in Settings → Providers, choose a keyless local observer, or turn observations off.`;
}

export function resolveAssistantMemoryDisabledReason(args: {
  assistantThreadRepository: AssistantThreadRepository | null;
  dbError: Error | null;
  dbInitializing: boolean;
  desktopAssistantBackendAvailable: boolean;
  memorySettings: RuntimeAssistantMemorySettings;
  providerKeySources?: readonly ProviderKeySource<SupportedProvider>[] | undefined;
  providerReadErrors?: Partial<Record<SupportedProvider, string>> | undefined;
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
  if (args.dbError) {
    return `Assistant memory database failed to initialize: ${args.dbError.message}`;
  }
  if (args.memoryLoadState?.status === 'idle' || args.memoryLoadState?.status === 'loading') {
    return 'Assistant memory is loading from PGlite.';
  }
  if (
    args.selectedProvider !== null &&
    !resolveHostedMemoryBackendAvailable({
      desktopAssistantBackendAvailable: args.desktopAssistantBackendAvailable,
      selectedProvider: args.selectedProvider,
    })
  ) {
    return 'Assistant memory for hosted providers requires the desktop assistant backend.';
  }
  if (args.dbInitializing || !args.assistantThreadRepository) {
    return 'Assistant memory is loading from PGlite.';
  }
  if (args.memoryLoadState?.status === 'error') {
    return `Assistant memory failed to load: ${args.memoryLoadState.error}`;
  }
  if (!args.selectedMemoryThreadId) {
    return 'Assistant memory has no selected thread for this workspace.';
  }
  if (!args.workspaceRootPath) {
    return;
  }
  const observationalMemoryDisabledReason = resolveObservationalMemoryDisabledReason({
    desktopAssistantBackendAvailable: args.desktopAssistantBackendAvailable,
    memorySettings: args.memorySettings,
    providerKeySources: args.providerKeySources,
    providerReadErrors: args.providerReadErrors,
    selectedProvider: args.selectedProvider,
  });
  if (observationalMemoryDisabledReason) {
    return observationalMemoryDisabledReason;
  }
  const semanticRecallDisabledReason = resolveSemanticRecallDisabledReason({
    memorySettings: args.memorySettings,
    providerKeySources: args.providerKeySources,
    providerReadErrors: args.providerReadErrors,
  });
  if (semanticRecallDisabledReason) {
    return semanticRecallDisabledReason;
  }
  return;
}

export function resolveHostedMemoryBackendAvailable(args: {
  desktopAssistantBackendAvailable: boolean;
  selectedProvider: SupportedProvider | null;
}): boolean {
  return args.selectedProvider === 'local' || args.desktopAssistantBackendAvailable;
}

export function createAssistantThreadRunPromise(args: {
  runConfig?: unknown;
  assistantThreadRepository: AssistantThreadRepository | null;
  memoryResourceId: string | undefined;
  modelSettings: RuntimeData['modelSettings'] | undefined;
  providerOptions: Record<string, unknown> | undefined;
  resolvedModelName: string | undefined;
  selectedMemoryThreadId: string | undefined;
  selectedProvider: SupportedProvider | null;
  /**
   * The turn's triggering user message (BST-1163) — the transport resolves it
   * from thread state per leg (action echoes excluded), so initial sends AND
   * approval/suspend resumes stamp the SAME id. `null` when the transport has
   * no real user message in hand; never fabricated here.
   */
  turnMessageId: string | null;
}): Promise<string | undefined> {
  if (!(args.assistantThreadRepository && args.memoryResourceId && args.selectedMemoryThreadId)) {
    throw new Error('Assistant run records require an active memory thread.');
  }
  if (!(args.selectedProvider && args.resolvedModelName)) {
    throw new Error('Assistant run records require a selected provider and model.');
  }

  const followup = readChildFollowupRunConfigAction(args.runConfig);
  const approval = readToolApprovalRunConfigAction(args.runConfig);
  const resume = readToolResumeRunConfigAction(args.runConfig);
  if (
    (followup && 'invalid' in followup) ||
    (approval && 'invalid' in approval) ||
    (resume && 'invalid' in resume) ||
    [followup, approval, resume].filter(Boolean).length > 1
  ) {
    throw new Error(
      'Assistant run preparation received conflicting or invalid child control input.'
    );
  }
  const decision =
    approval && 'action' in approval
      ? approval.action
      : resume && 'action' in resume
        ? resume.action
        : undefined;
  const childContinuation = decision?.continuationId
    ? { id: decision.continuationId, nativeRunId: decision.runId }
    : undefined;
  const turnMessageId = followup && 'action' in followup ? followup.action.id : args.turnMessageId;
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
      turnMessageId,
      ...(childContinuation ? { childContinuation } : {}),
      ...(args.modelSettings ? { modelSettings: { ...args.modelSettings } } : {}),
      ...(args.providerOptions ? { providerOptions: { ...args.providerOptions } } : {}),
    })
    .then((record: AssistantThreadRunRecord) => record.id);
}

export function buildAssistantRequestData(args: {
  agentLoopSettings: RuntimeData['agentLoop'] | undefined;
  /** Durable thread-scoped operating root, validated by the desktop server. */
  boundWorkspaceRootId?: string | undefined;
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
   * Plan mode (opt-in). Attached ONLY when `true` (presence-means-on); the
   * server constrains the tool map and prepends the plan-mode instructions.
   * Absent → normal run.
   *
   * NOTE: `permissionPolicyRequest` is deliberately NOT built here. Its sole
   * producer is `prepareRequestData` (hooks/use-assistant-request-lifecycle.ts),
   * which reads the live permission-policy store at request-composition time
   * and sets the field unconditionally — a render-time value would always be
   * overwritten, so building one here would only cost a subscription (BST-1652).
   */
  planMode?: boolean;
  providerOptions: Record<string, unknown> | undefined;
  /** Explicit selection only; absent means Auto even when providerOptions has a resolved effort. */
  requestedReasoningEffort?: RuntimeData['requestedReasoningEffort'];
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
  experimentAssignment?: RuntimeData['experimentAssignment'];
  selfImprovementSignalPreference?: RuntimeData['selfImprovementSignalPreference'];
  subagentPersonasRequest?: RuntimeData['subagentPersonasRequest'];
  /**
   * Per-child subagent budgets (Settings → Models → Subagents). REQUIRED and
   * sent on every request: the defaults are a real value, and the host
   * validates whatever arrives (`parseRuntimeSubagentSettings`).
   */
  subagentSettings: RuntimeSubagentSettings;
  /**
   * Opt-in workspace instructions preference; only set on the desktop
   * data-stream transport (web has no injection path). A preference, not a
   * security boundary — the server reads it directly.
   */
  workspaceInstructionsPreference?: RuntimeData['workspaceInstructionsPreference'];
  workspaceRootPath: string | null;
}): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (args.boundWorkspaceRootId) {
    data['boundWorkspaceRootId'] = args.boundWorkspaceRootId;
  }
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
  // Always sent: the defaults are a real value, and the host validates
  // whatever arrives (`parseRuntimeSubagentSettings`) rather than assuming.
  data['subagentSettings'] = args.subagentSettings;
  if (args.providerOptions) {
    data['providerOptions'] = args.providerOptions;
  }
  attachOptInRequestFields(data, args);
  return data;
}

interface OptInRequestFields {
  experimentAssignment?: RuntimeData['experimentAssignment'];
  hookTrustRequest?: HookTrustRequest | undefined;
  planMode?: boolean;
  requestedReasoningEffort?: RuntimeData['requestedReasoningEffort'];
  selfImprovementSignalPreference?: RuntimeData['selfImprovementSignalPreference'];
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
  // Explicit effort is presence-means-user-selected; absent means Auto even
  // when resolved provider options carry a catalog-selected wire effort.
  if (fields.requestedReasoningEffort) {
    data['requestedReasoningEffort'] = fields.requestedReasoningEffort;
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
  // Self-improvement is default OFF; the desktop renderer sends its explicit
  // plain-JSON preference snapshot and the server parses it strictly.
  if (fields.selfImprovementSignalPreference) {
    data['selfImprovementSignalPreference'] = fields.selfImprovementSignalPreference;
  }
  // Skills preference: absent => server default (master on, nothing disabled).
  if (fields.skillsPreference) {
    data['skillsPreference'] = fields.skillsPreference;
  }
  // Experiment enrollment (BST-1251): presence-means-enrolled attribution
  // metadata; the caller only supplies a complete {experimentId, variant}
  // pair, matching the contract's jointly-required fields.
  if (fields.experimentAssignment) {
    data['experimentAssignment'] = fields.experimentAssignment;
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
  configuredProviders: readonly SupportedProvider[];
  currentModel: string | null | undefined;
  getProviderLlmModels: (provider: SupportedProvider) => readonly LlmProviderModelDefinition[];
  localRuntimeHint: string | undefined;
  providerHasEnabledModels: (provider: SupportedProvider) => boolean;
  providerReadErrors?: Partial<Record<SupportedProvider, string>>;
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
    const baseReason = 'Connect an AI provider in Settings → Providers to enable the assistant.';
    return args.localRuntimeHint ? `${baseReason} ${args.localRuntimeHint}` : baseReason;
  }
  if (!args.selectedProvider) {
    return 'Select an AI provider to start chatting.';
  }
  const providerReadError = args.providerReadErrors?.[args.selectedProvider];
  if (providerReadError) {
    return providerReadError;
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
    contextWindow: DYNAMIC_LOCAL_MODEL_CONTEXT_WINDOW,
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

function findOpenRouterCatalogModel(modelId: string): OpenRouterAutoProfileModel | undefined {
  return listProviderLlmModels('openrouter').find(({ id }) => id === modelId);
}

/**
 * The model the output-window resolution reasons about: the live snapshot with
 * the catalog-only facts (`autoEffort`, `vendorDefaultOutputTokens`) merged
 * back in, or the static catalog entry while metadata is pending. The catalog
 * overlay only applies when the snapshot identity matches the selected model.
 */
function resolveAutoProfileModel(
  openRouterMetadata: OpenRouterModelMetadata | undefined,
  modelName: string | undefined
): OpenRouterAutoProfileModel | undefined {
  if (openRouterMetadata) {
    const catalogModel =
      modelName !== undefined && openRouterMetadata.id === modelName
        ? findOpenRouterCatalogModel(modelName)
        : undefined;
    return mergeOpenRouterAutoProfileModel(openRouterMetadata, catalogModel);
  }
  return modelName === undefined ? undefined : getLlmModelDefinition('openrouter', modelName);
}

export function buildEffectiveModelSettings(
  providerId: string | null | undefined,
  configuredSettings: RuntimeData['modelSettings'] | undefined,
  selectedModelDef?: SelectedModelBudgetDef,
  openRouterMetadata?: OpenRouterModelMetadata,
  modelName?: string,
  reasoningEffort?: AssistantProviderSettings['reasoningEffort']
): RuntimeData['modelSettings'] | undefined {
  if (providerId !== 'openrouter') {
    return configuredSettings;
  }
  if (configuredSettings?.maxOutputTokens !== undefined) {
    return configuredSettings;
  }
  const autoProfileModel = resolveAutoProfileModel(openRouterMetadata, modelName);
  if (autoProfileModel) {
    // Sized for the request's reasoning state (BST-1170): an active-reasoning
    // request on a model with a vendor-documented completion window gets that
    // window — the 32K coding ceiling starved thinking+answer and killed runs
    // at `finishReason: length`.
    return {
      ...configuredSettings,
      maxOutputTokens: resolveOpenRouterOutputWindow(
        autoProfileModel,
        resolveOpenRouterReasoningActive(autoProfileModel, reasoningEffort)
      ),
    };
  }
  return {
    ...configuredSettings,
    maxOutputTokens: resolveOpenRouterCodingMaxOutputTokens(selectedModelDef?.maxOutputTokens),
  };
}

const openRouterLimitFormatter = new Intl.NumberFormat();

export function resolveOpenRouterMetadataDisabledReason(
  providerId: string | null | undefined,
  settings: AssistantProviderSettings | undefined,
  lookup: OpenRouterModelMetadataLookup | undefined,
  modelSettings?: RuntimeData['modelSettings']
): string | undefined {
  if (!(providerId === 'openrouter' && lookup?.state === 'resolved')) {
    return;
  }
  const configuredOutput = buildPositiveIntegerSetting(
    modelSettings?.maxOutputTokens ?? settings?.maxOutputTokens
  );
  const metadata = lookup.snapshot.metadata;
  const maximum = metadata.maxOutputTokens;
  const provenance = lookup.snapshot.freshness === 'stale-cache' ? 'cached' : 'live';
  if (configuredOutput && maximum && configuredOutput > maximum) {
    return `Configured output limit ${openRouterLimitFormatter.format(configuredOutput)} exceeds OpenRouter ${provenance} maximum ${openRouterLimitFormatter.format(maximum)}.`;
  }
  const profileModel =
    mergeOpenRouterAutoProfileModel(metadata, findOpenRouterCatalogModel(metadata.id)) ?? metadata;
  if (settings?.reasoningEffort === undefined) {
    try {
      resolveOpenRouterAutoRuntimeProfile(profileModel, configuredOutput);
    } catch (error) {
      return error instanceof Error
        ? error.message
        : 'OpenRouter Auto reasoning profile is invalid.';
    }
  }

  // Reserve the same window the run will actually send (BST-1170): an
  // active-reasoning request on a model with a vendor-documented completion
  // window reserves that window, not the coding ceiling — otherwise the input
  // validation promises context the run cannot use.
  const outputReservation =
    configuredOutput ??
    resolveOpenRouterOutputWindow(
      profileModel,
      resolveOpenRouterReasoningActive(profileModel, settings?.reasoningEffort || undefined)
    );
  let effectiveInputBudget: number;
  try {
    effectiveInputBudget = deriveEffectiveInputBudget(metadata.contextWindow, outputReservation);
  } catch {
    return `Configured output limit ${openRouterLimitFormatter.format(outputReservation)} cannot fit within the OpenRouter ${provenance} context window ${openRouterLimitFormatter.format(metadata.contextWindow)} plus its safety margin.`;
  }

  const configuredInput = buildPositiveIntegerSetting(settings?.agentInputTokenLimit);
  if (configuredInput && configuredInput > effectiveInputBudget) {
    return `Configured input limit ${openRouterLimitFormatter.format(configuredInput)} exceeds OpenRouter ${provenance} effective input budget ${openRouterLimitFormatter.format(effectiveInputBudget)}.`;
  }
  return;
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
  selectedModelDef?: SelectedModelBudgetDef,
  providerId?: string | null,
  modelSettings?: RuntimeData['modelSettings']
): RuntimeData['agentLoop'] | undefined {
  const maxSteps = buildPositiveIntegerSetting(settings?.agentMaxSteps);
  let inputTokenLimit = buildPositiveIntegerSetting(settings?.agentInputTokenLimit);
  if (inputTokenLimit === undefined && selectedModelDef !== undefined) {
    const outputReservation =
      providerId === 'openrouter'
        ? (buildPositiveIntegerSetting(modelSettings?.maxOutputTokens) ??
          buildPositiveIntegerSetting(settings?.maxOutputTokens) ??
          resolveOpenRouterCodingMaxOutputTokens(selectedModelDef.maxOutputTokens))
        : selectedModelDef.maxOutputTokens;
    inputTokenLimit = deriveEffectiveInputBudget(selectedModelDef.contextWindow, outputReservation);
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
  const reasoningEffort = settings.reasoningEffort || undefined;
  // Without a summary the Responses API reasons silently and the disclosure
  // has nothing to reveal, so visibility supplies `auto` when the user has not
  // asked for a specific verbosity. Only ever MODIFIES a reasoning request
  // that is already being made — cleared settings must still yield no options.
  const reasoningSummary =
    settings.reasoningSummary ||
    (reasoningEffort && resolveReasoningVisible(settings) ? 'auto' : undefined);
  return buildOptionalOptions<OpenAiProviderOptions>([
    ['reasoningEffort', reasoningEffort],
    ['reasoningSummary', reasoningSummary],
  ]);
}

function assertOpenRouterReasoningEffortSupported(
  modelName: string,
  reasoningEffort: NonNullable<AssistantProviderSettings['reasoningEffort']>,
  metadata: OpenRouterModelMetadata | undefined
): void {
  const model = getLlmModelDefinition('openrouter', modelName);
  const reasoning =
    metadata?.id === modelName && metadata.reasoning ? metadata.reasoning : model.reasoning;
  if (!reasoning) {
    throw new Error(
      `OpenRouter model "${model.label ?? model.id}" does not declare support for reasoning effort "${reasoningEffort}".`
    );
  }
  if (reasoningEffort === 'none') {
    if (!reasoning.mandatory) {
      return;
    }
    throw new Error(
      `OpenRouter model "${model.label ?? model.id}" does not support reasoning effort "${reasoningEffort}".`
    );
  }
  const supportedEfforts = reasoning.supportedEfforts;
  if (!supportedEfforts) {
    throw new Error(
      `OpenRouter model "${model.label ?? model.id}" does not declare support for reasoning effort "${reasoningEffort}".`
    );
  }
  if (!supportedEfforts.includes(reasoningEffort)) {
    throw new Error(
      `OpenRouter model "${model.label ?? model.id}" does not support reasoning effort "${reasoningEffort}". Supported efforts: ${supportedEfforts.join(', ')}.`
    );
  }
}

function buildOpenRouterOptions(
  modelName: string | undefined,
  settings: AssistantProviderSettings,
  metadata?: OpenRouterModelMetadata
): OpenRouterProviderOptions | undefined {
  const reasoningEffort = settings.reasoningEffort;
  if (modelName && reasoningEffort) {
    assertOpenRouterReasoningEffortSupported(modelName, reasoningEffort, metadata);
  }
  const autoEffort =
    reasoningEffort === undefined && modelName
      ? resolveOpenRouterAutoRuntimeProfile(
          // Live metadata cannot carry our catalog-only `autoEffort`, so it is
          // merged back in rather than selected away (see
          // mergeOpenRouterAutoProfileModel).
          mergeOpenRouterAutoProfileModel(
            metadata?.id === modelName ? metadata : undefined,
            getLlmModelDefinition('openrouter', modelName)
          ) ?? getLlmModelDefinition('openrouter', modelName),
          settings.maxOutputTokens
        ).reasoningEffort
      : undefined;
  const resolvedReasoningEffort = reasoningEffort ?? autoEffort;
  const reasoningOff = resolvedReasoningEffort === 'none';
  // OpenRouter already RETURNS reasoning whenever reasoning is on, so the
  // visible path adds nothing — critical under `require_parameters`, which
  // narrows routing to endpoints supporting every supplied parameter. Only an
  // explicit opt-out adds the documented `exclude`, and never alongside
  // reasoning that is already switched off.
  const exclude = reasoningOff || resolveReasoningVisible(settings) ? undefined : true;
  const reasoning = buildOptionalOptions<NonNullable<OpenRouterProviderOptions['reasoning']>>([
    ['enabled', reasoningOff ? false : undefined],
    ['effort', reasoningOff ? undefined : resolvedReasoningEffort],
    ['exclude', exclude],
    ['summary', settings.reasoningSummary || undefined],
  ]);
  return {
    provider: {
      // OpenRouter otherwise permits routing to an endpoint that silently
      // ignores requested reasoning/tool parameters.
      // biome-ignore lint/style/useNamingConvention: OpenRouter wire field.
      require_parameters: true,
    },
    ...(reasoning ? { reasoning } : {}),
  };
}

/**
 * Direct Anthropic reasoning (BST-847).
 *
 * The OFFERED ladder is declared per model in the registry, never inferred
 * from the SDK enum. Persisted provider-wide effort can outlive its model:
 * an unsupported effort is ABSENT, never coerced to a neighbour, and cannot
 * manufacture adaptive thinking. No declared ladder means no effort; an
 * explicit legacy thinking budget remains independently configured.
 */
function buildAnthropicOptions(
  modelName: string | undefined,
  settings: AssistantProviderSettings
): AnthropicProviderOptions | undefined {
  const reasoning = modelName
    ? findLlmModelDefinition('anthropic', modelName)?.anthropicReasoning
    : undefined;
  const requestedEffort = settings.anthropicEffort;
  const effort =
    requestedEffort && reasoning?.supportedEfforts.includes(requestedEffort)
      ? requestedEffort
      : undefined;
  // An explicit budget pins the legacy `enabled` form (older models); it also
  // carries no `display`, so it is left exactly as configured. Otherwise the
  // modern adaptive form carries `display`, which defaults to `omitted`
  // provider-side — the reason Claude runs showed no thinking at all. Only
  // emitted alongside a chosen effort. Opus 5 thinks when options are omitted,
  // so cleared UI settings explicitly disable it after clearing effort.
  const thinking: AnthropicProviderOptions['thinking'] | undefined =
    typeof settings.anthropicThinkingBudgetTokens === 'number'
      ? {
          budgetTokens: Math.floor(settings.anthropicThinkingBudgetTokens),
          type: 'enabled',
        }
      : effort
        ? {
            display: resolveReasoningVisible(settings) ? 'summarized' : 'omitted',
            type: 'adaptive',
          }
        : modelName === 'claude-opus-5'
          ? { type: 'disabled' }
          : undefined;
  return buildOptionalOptions<AnthropicProviderOptions>([
    ['effort', effort],
    ['thinking', thinking],
  ]);
}

/**
 * Bedrock reasoning (BST-1354).
 *
 * The wire shape is chosen by the model's REGISTRY dialect, never by sniffing
 * the model id: adaptive Claude routes reject the legacy `enabled` form, and
 * Amazon Nova has no token budget at all. An effort the route does not offer
 * yields NO options rather than a config the API would reject — persisted
 * settings outlive model switches, and `bedrockEffort` is provider-wide while
 * the ladder is per model.
 */
function buildBedrockOptions(
  modelName: string | undefined,
  settings: AssistantProviderSettings
): BedrockProviderOptions | undefined {
  const effort = settings.bedrockEffort;
  if (!(modelName && effort)) {
    return;
  }
  // Keyed on the UNPREFIXED catalog id, which is all this seam can receive:
  // both the registry and the DB model catalog (migration 100) store Bedrock
  // ids unprefixed, and the cross-region routing prefix is applied per request
  // inside packages/agent. The agent-side capability lookup resolves a routed
  // id back to its catalog row for the same reason; if a prefixed id ever
  // reaches HERE, that invariant has already broken upstream.
  const dialect = findLlmModelDefinition('bedrock', modelName)?.bedrockReasoning;
  if (!(dialect && BEDROCK_REASONING_EFFORTS[dialect].includes(effort))) {
    return;
  }
  if (dialect === 'adaptive') {
    return {
      reasoningConfig: {
        // The one Bedrock dialect whose `display` the SDK forwards, so it is
        // the one that carries the shared visibility switch.
        display: resolveBedrockReasoningDisplay(settings),
        maxReasoningEffort: effort,
        type: 'adaptive',
      },
    };
  }
  if (dialect === 'max-reasoning-effort') {
    return { reasoningConfig: { maxReasoningEffort: effort, type: 'enabled' } };
  }
  // `budget-tokens`: the offered ladder and the budget table are pinned equal
  // by the dialect contract spec, so this lookup should always hit — but it is
  // a PARTIAL record, so a miss bails explicitly rather than sending
  // `budgetTokens: undefined`, which the API would reject.
  const budgetTokens = BEDROCK_BUDGET_TOKENS_BY_EFFORT[effort];
  if (budgetTokens === undefined) {
    return;
  }
  return { reasoningConfig: { budgetTokens, type: 'enabled' } };
}

function buildGoogleOptions(
  modelName: string | undefined,
  settings: AssistantProviderSettings
): GoogleProviderOptions | undefined {
  const resolvedLevel = resolveGoogleThinkingLevel(modelName, settings.googleThinkingLevel);
  // Gemini withholds thoughts unless asked; the flag was declared in the
  // contract but never set, so thinking was invisible on every Google run.
  // Tied to a resolved level so a dropped/absent level yields no options.
  const includeThoughts =
    typeof settings.googleIncludeThoughts === 'boolean'
      ? settings.googleIncludeThoughts
      : resolvedLevel
        ? resolveReasoningVisible(settings)
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
  settings: AssistantProviderSettings | undefined,
  openRouterMetadata?: OpenRouterModelMetadata
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
      const openrouter = buildOpenRouterOptions(modelName, settings, openRouterMetadata);
      return openrouter ? { openrouter } : undefined;
    }
    case 'anthropic': {
      const anthropic = buildAnthropicOptions(modelName, settings);
      return anthropic ? { anthropic } : undefined;
    }
    case 'bedrock': {
      const bedrock = buildBedrockOptions(modelName, settings);
      return bedrock ? { bedrock } : undefined;
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

export function buildProviderOptionsWhenReady(
  disabledReason: string | undefined,
  providerId: SupportedProvider | null,
  modelName: string | undefined,
  settings: AssistantProviderSettings | undefined,
  openRouterLookup?: OpenRouterModelMetadataLookup
): RuntimeData['providerOptions'] | undefined {
  if (disabledReason) {
    return;
  }
  return buildProviderOptions(
    providerId,
    modelName,
    settings,
    openRouterLookup?.state === 'resolved' ? openRouterLookup.snapshot.metadata : undefined
  );
}

/**
 * Bedrock counterpart of the OpenRouter reconciler (BST-1354).
 *
 * `bedrockEffort` is provider-wide but the ladder that gives it meaning is
 * PER MODEL — `max` exists only on the legacy budget-token route, Nova offers
 * low/medium/high, and several Bedrock routes reason not at all. Carrying a
 * stale effort across a model switch left the Effort control displaying it
 * while `buildBedrockOptions` correctly declined to send it: a control lying
 * about the request. Clearing it restores "Auto", which is what actually runs.
 *
 * An UNCATALOGUED model is left alone, mirroring the OpenRouter reconciler:
 * with no registry row there is no ladder to judge against, and that route
 * shows no effort control to lie with.
 */
function reconcileBedrockSettingsForModel(
  modelName: string,
  settings: AssistantProviderSettings
): AssistantProviderSettings {
  const effort = settings.bedrockEffort;
  if (!effort) {
    return settings;
  }
  const definition = findLlmModelDefinition('bedrock', modelName);
  if (!definition) {
    return settings;
  }
  const dialect = definition.bedrockReasoning;
  if (dialect && BEDROCK_REASONING_EFFORTS[dialect].includes(effort)) {
    return settings;
  }
  const { bedrockEffort: _unsupportedBedrockEffort, ...compatibleSettings } = settings;
  return compatibleSettings;
}

/**
 * Anthropic counterpart of the Bedrock reconciler (BST-847). Clear a
 * provider-wide effort the selected model cannot offer so the controls show
 * what the request builder actually sends. Haiku declares no effort ladder.
 * An UNCATALOGUED model is left alone: with no registry row there is no ladder
 * to judge against, and that route shows no effort control.
 */
function reconcileAnthropicSettingsForModel(
  modelName: string,
  settings: AssistantProviderSettings
): AssistantProviderSettings {
  const effort = settings.anthropicEffort;
  if (!effort) {
    return settings;
  }
  const definition = findLlmModelDefinition('anthropic', modelName);
  if (!definition) {
    return settings;
  }
  if (definition.anthropicReasoning?.supportedEfforts.includes(effort)) {
    return settings;
  }
  const { anthropicEffort: _unsupportedAnthropicEffort, ...compatibleSettings } = settings;
  return compatibleSettings;
}

function reconcileGoogleSettingsForModel(
  modelName: string,
  settings: AssistantProviderSettings
): AssistantProviderSettings {
  const level = settings.googleThinkingLevel;
  if (!(level && !getGoogleThinkingLevels(modelName).includes(level))) {
    return settings;
  }
  const { googleThinkingLevel: _unsupportedGoogleThinkingLevel, ...compatibleSettings } = settings;
  return compatibleSettings;
}

/**
 * Clear provider-wide overrides when the user explicitly switches to a model
 * that cannot honor them. The model's documented defaults then remain visible
 * as "Auto" in the settings controls. This reconciler owns explicit switches
 * only; request validation separately owns stale persisted state.
 */
export function reconcileProviderSettingsForModel(
  providerId: SupportedProvider,
  modelName: string,
  settings: AssistantProviderSettings | undefined
): AssistantProviderSettings | undefined {
  if (providerId === 'anthropic' && settings) {
    return reconcileAnthropicSettingsForModel(modelName, settings);
  }
  if (providerId === 'google' && settings) {
    return reconcileGoogleSettingsForModel(modelName, settings);
  }
  if (providerId === 'bedrock' && settings) {
    return reconcileBedrockSettingsForModel(modelName, settings);
  }
  if (!(providerId === 'openrouter' && settings)) {
    return settings;
  }
  const model = getProviderDefinition('openrouter').models.find(
    (candidate) => candidate.id === modelName
  );
  if (model?.type !== 'llm') {
    return settings;
  }
  const clearReasoningEffort = Boolean(
    settings.reasoningEffort &&
      !model.reasoning?.supportedEfforts.includes(settings.reasoningEffort)
  );
  const clearMaxOutputTokens = Boolean(
    settings.maxOutputTokens &&
      model.maxOutputTokens &&
      settings.maxOutputTokens > model.maxOutputTokens
  );
  if (!(clearReasoningEffort || clearMaxOutputTokens)) {
    return settings;
  }
  if (clearReasoningEffort && clearMaxOutputTokens) {
    const {
      maxOutputTokens: _unsupportedMaxOutputTokens,
      reasoningEffort: _unsupportedReasoningEffort,
      ...compatibleSettings
    } = settings;
    return compatibleSettings;
  }
  if (clearMaxOutputTokens) {
    const { maxOutputTokens: _unsupportedMaxOutputTokens, ...compatibleSettings } = settings;
    return compatibleSettings;
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
  openRouterLookup,
  provider,
  providerSettingsMap,
}: {
  readonly model: string | undefined;
  readonly openRouterLookup?: OpenRouterModelMetadataLookup | undefined;
  readonly provider: SupportedProvider;
  readonly providerSettingsMap: Record<string, AssistantProviderSettings>;
}) {
  const settings = providerSettingsMap[provider];
  const modelSettings = buildModelSettings(settings);
  const providerOptions = model
    ? buildProviderOptions(
        provider,
        model,
        settings,
        openRouterLookup?.state === 'resolved' ? openRouterLookup.snapshot.metadata : undefined
      )
    : undefined;
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

/** Finish-usage payload delivered by the data-stream runtime's onUsage tap. */
export interface AssistantRunUsagePayload {
  readonly billedCostUsd?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly contextInputTokens?: number;
  readonly contextOutputTokens?: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Select provider-effective context for the transient meter; billing keeps run totals. */
export function pickContextMeterUsage(usage: AssistantRunUsagePayload): {
  inputTokens: number;
  outputTokens: number;
} {
  return {
    inputTokens: usage.contextInputTokens ?? usage.inputTokens,
    outputTokens: usage.contextOutputTokens ?? usage.outputTokens,
  };
}

/**
 * Anthropic cache token classes for the durable run-usage row, present only
 * when reported (BST-587). Absent fields keep pre-cache rows byte-identical.
 */
export function pickCacheTokenFields(usage: AssistantRunUsagePayload): {
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
} {
  return {
    ...(usage.cacheCreationInputTokens === undefined
      ? {}
      : { cacheCreationInputTokens: usage.cacheCreationInputTokens }),
    ...(usage.cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens: usage.cacheReadInputTokens }),
  };
}
