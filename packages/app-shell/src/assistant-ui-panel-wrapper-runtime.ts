import {
  BEDROCK_REASONING_EFFORTS,
  buildModelSettings,
  buildProviderOptions,
  DESKTOP_NATIVE_TOOL_IDS,
  type DesktopNativeToolId,
  deriveAgentLoopInputTokenLimit,
  deriveEffectiveInputBudget,
  findLlmModelDefinition,
  findOpenRouterCatalogModel,
  mergeOpenRouterAutoProfileModel,
  type OpenRouterAutoProfileModel,
  type OpenRouterModelMetadataLookup,
  openRouterReasoningEffortIssue,
  type ProviderKeySource,
  type RuntimeData,
  resolveOpenRouterAutoRuntimeProfile,
  resolveOpenRouterOutputWindow,
  resolveOpenRouterReasoningActive,
  type SelectedModelBudgetDef,
  WEB_NATIVE_TOOL_IDS,
} from '@brainstrike/assistant-contract';
import {
  DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
  DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
  listAutoObservationalMemoryCandidates,
  OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET,
  type RuntimeAssistantObservationalMemorySettings,
} from '@brainstrike/assistant-contract/memory-settings';
import {
  getProviderDefinition,
  getProviderModelDefinitions,
  isSupportedProvider,
  type ModelVisionSupport,
  type ProviderModelDefinition,
  type SupportedProvider,
} from '@brainstrike/assistant-contract/provider-metadata';
import { getNativeToolDescription } from '@brainstrike/assistant-contract/tool-metadata';
import type { AssistantThreadMetadata } from '@brainstrike/assistant-data';
import type {
  AssistantProviderSettings,
  AssistantToolMenuItem,
  ComposerAttachmentsAvailability,
} from '@brainstrike/assistant-ui';
import { getGoogleThinkingLevels } from '@brainstrike/types';

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
}): readonly DesktopNativeToolId[] {
  if (!args.desktopBridgeAvailable) {
    return WEB_NATIVE_TOOL_IDS;
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

export function formatToolLabel(toolId: string): string {
  const name = toolId.split('.').pop() ?? toolId;
  const spaced = name
    .replace(/([a-z])([A-Z])/gu, '$1 $2')
    .replace(/[-_]/gu, ' ')
    .trim();
  return spaced.replace(/\b\w/gu, (match) => match.toUpperCase());
}

export function getToolDescription(toolId: string): string {
  return getNativeToolDescription(toolId) ?? `Tool: ${toolId}`;
}

/** Why an 'auto' observer target could not resolve to a concrete model. */
type ObservationalMemoryAutoUnresolvedReason =
  | 'keys-unknown'
  | 'model-not-eligible'
  | 'no-backend'
  | 'no-chat-provider';

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
 * conversation. An unkeyed chat provider, or a candidate disabled in the
 * user's model catalog (isTargetEligible), flips enabled→false with an
 * explicit unresolved reason instead. Explicit (non-auto) targets pass through
 * untouched so misconfiguration keeps its loud validation. 'auto' must never
 * reach the provider/model validator.
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
    return unresolved('no-chat-provider');
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

/**
 * Why the assistant cannot send yet, and, when a Settings page is the fix,
 * that page: its category id (`#settings/{id}`) and the action's label. A
 * reason the composer itself fixes (pick a provider or model) names none.
 */
export interface AssistantProviderNotice {
  readonly message: string;
  readonly settings?: { readonly categoryId: string; readonly label: string } | undefined;
}

const CONNECT_PROVIDER = { categoryId: 'providers', label: 'Connect a provider' } as const;
const OPEN_PROVIDERS = { categoryId: 'providers', label: 'Open provider settings' } as const;
const ENABLE_MODELS = { categoryId: 'model-catalog', label: 'Enable models' } as const;

export function resolveAssistantProviderDisabledReason(args: {
  configuredProviders: readonly SupportedProvider[];
  currentModel: string | null | undefined;
  providerHasEnabledModels: (provider: SupportedProvider) => boolean;
  providerReadErrors?: Partial<Record<SupportedProvider, string>>;
  selectedProvider: SupportedProvider | null;
}): AssistantProviderNotice | undefined {
  if (args.configuredProviders.length === 0) {
    return {
      message: 'Connect an AI provider in Settings → Providers to enable the assistant.',
      settings: CONNECT_PROVIDER,
    };
  }
  if (!args.selectedProvider) {
    return { message: 'Select an AI provider to start chatting.' };
  }
  const providerReadError = args.providerReadErrors?.[args.selectedProvider];
  if (providerReadError) {
    return { message: providerReadError, settings: OPEN_PROVIDERS };
  }
  if (!args.configuredProviders.includes(args.selectedProvider)) {
    return { message: 'The selected provider is no longer configured.', settings: OPEN_PROVIDERS };
  }
  if (!args.providerHasEnabledModels(args.selectedProvider)) {
    const definition = getProviderDefinition(args.selectedProvider);
    return {
      message: `Enable at least one model for ${definition.displayName} to continue.`,
      settings: ENABLE_MODELS,
    };
  }
  if (!args.currentModel) {
    return { message: 'Select a model for the chosen provider to continue.' };
  }
  return;
}

export type LlmProviderModelDefinition = ProviderModelDefinition & { type: 'llm' };

/**
 * Composer image-attachment gate. Every provider is eligible — the desktop
 * assistant server and the web /api/assistant route share the same image-aware
 * conversion — so the SELECTED MODEL's vision capability is the whole decision:
 * 'enabled', or a visibly 'disabled' button carrying the reason, never a silent
 * hide. An unresolved definition stays optimistic: a wrong guess surfaces as
 * a visible provider error downstream, whereas guessing 'unsupported' would
 * silently block a capable model.
 */
export function resolveComposerAttachmentsAvailability(args: {
  readonly selectedModel:
    | {
        readonly id: string;
        readonly label?: string | undefined;
        readonly vision: ModelVisionSupport;
      }
    | undefined;
}): ComposerAttachmentsAvailability {
  if (args.selectedModel?.vision === 'unsupported') {
    const modelName = args.selectedModel.label ?? args.selectedModel.id;
    return {
      reason: `${modelName} doesn't support image input. Switch to a vision-capable model to attach images.`,
      state: 'disabled',
    };
  }
  return { state: 'enabled' };
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

export function getProviderLlmModelDefinitions(
  provider: SupportedProvider,
  fixedModels: readonly string[] | undefined
): readonly LlmProviderModelDefinition[] {
  const modelDefinitions = getProviderModelDefinitions(provider);
  if (!fixedModels) {
    return modelDefinitions;
  }
  const fixedModelIds = new Set(fixedModels);
  return modelDefinitions.filter((model) => fixedModelIds.has(model.id));
}

interface McpToolDescriptor {
  description?: string | undefined;
  enabled: boolean;
  id: string;
}

export type McpToolMap = Record<string, McpToolDescriptor[]>;

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
      });
    }
  }
  return items;
}

export type RuntimeMemoryOptions = NonNullable<RuntimeData['memory']>['memoryOptions'];

const openRouterLimitFormatter = new Intl.NumberFormat();

/** The send's gate while an OpenRouter model's details load. */
const OPENROUTER_METADATA_LOADING_REASON = 'Loading OpenRouter model details…';

/**
 * The gate an OpenRouter lookup sets by its state and the chosen effort: the
 * details still loading, or an effort the model cannot take. A failed lookup
 * checks the effort against the catalog's own definition and says so.
 */
function openRouterLookupReason(
  lookup: OpenRouterModelMetadataLookup,
  effort: AssistantProviderSettings['reasoningEffort'],
  modelId: string | undefined
): string | undefined {
  if (lookup.state === 'loading') {
    return OPENROUTER_METADATA_LOADING_REASON;
  }
  if (!effort) {
    return;
  }
  if (lookup.state === 'resolved') {
    const { metadata } = lookup.snapshot;
    return openRouterReasoningEffortIssue(metadata.id, effort, metadata);
  }
  const issue = modelId ? openRouterReasoningEffortIssue(modelId, effort, undefined) : undefined;
  return issue && `${issue} OpenRouter model details could not load: ${lookup.message}`;
}

/**
 * Why an OpenRouter send is gated by its model's details, or undefined. While
 * the lookup loads the send waits, so provider options are never built from
 * details that have not arrived. A chosen reasoning effort the model does not
 * support is a notice here, never a throw while the composer renders.
 *
 * When the details fail to load, the run budgets on the built-in catalog row,
 * so the same input-budget check runs against it (BST-1810): a persisted
 * output limit that row cannot fit is named here, never thrown by
 * `buildAgentLoopSettings` during render.
 */
export function resolveOpenRouterMetadataDisabledReason(
  providerId: string | null | undefined,
  settings: AssistantProviderSettings | undefined,
  lookup: OpenRouterModelMetadataLookup | undefined,
  modelSettings?: RuntimeData['modelSettings'],
  modelId?: string
): string | undefined {
  if (!(providerId === 'openrouter' && lookup)) {
    return;
  }
  const lookupReason = openRouterLookupReason(lookup, settings?.reasoningEffort, modelId);
  if (lookupReason !== undefined || lookup.state === 'loading') {
    return lookupReason;
  }
  const configuredOutput = buildPositiveIntegerSetting(
    modelSettings?.maxOutputTokens ?? settings?.maxOutputTokens
  );
  if (lookup.state === 'error') {
    const catalogModel = modelId ? findLlmModelDefinition('openrouter', modelId) : undefined;
    return catalogModel
      ? openRouterInputBudgetReason(
          settings,
          configuredOutput,
          catalogModel,
          catalogModel.contextWindow,
          'built-in catalog'
        )
      : undefined;
  }
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
  return openRouterInputBudgetReason(
    settings,
    configuredOutput,
    profileModel,
    metadata.contextWindow,
    provenance
  );
}

/**
 * Why the window cannot hold the output the run reserves plus the configured
 * input limit, or undefined. The reservation is the window the run actually
 * sends (BST-1170): an active-reasoning request on a model with a
 * vendor-documented completion window reserves that window, not the coding
 * ceiling — otherwise the input validation promises context the run cannot use.
 */
function openRouterInputBudgetReason(
  settings: AssistantProviderSettings | undefined,
  configuredOutput: number | undefined,
  profileModel: OpenRouterAutoProfileModel,
  contextWindow: number,
  provenance: string
): string | undefined {
  const outputReservation =
    configuredOutput ??
    resolveOpenRouterOutputWindow(
      profileModel,
      resolveOpenRouterReasoningActive(profileModel, settings?.reasoningEffort || undefined)
    );
  let effectiveInputBudget: number;
  try {
    effectiveInputBudget = deriveEffectiveInputBudget(contextWindow, outputReservation);
  } catch {
    return `Configured output limit ${openRouterLimitFormatter.format(outputReservation)} cannot fit within the OpenRouter ${provenance} context window ${openRouterLimitFormatter.format(contextWindow)} plus its safety margin.`;
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
 * Matches the required fields on LlmModelDefinition, so callers can pass a
 * registry definition without a re-lookup.
 */

export function buildAgentLoopSettings(
  settings: AssistantProviderSettings | undefined,
  selectedModelDef?: SelectedModelBudgetDef,
  providerId?: string | null,
  modelSettings?: RuntimeData['modelSettings']
): RuntimeData['agentLoop'] | undefined {
  const maxSteps = buildPositiveIntegerSetting(settings?.agentMaxSteps);
  let inputTokenLimit = buildPositiveIntegerSetting(settings?.agentInputTokenLimit);
  if (inputTokenLimit === undefined && selectedModelDef !== undefined) {
    inputTokenLimit = deriveAgentLoopInputTokenLimit(
      selectedModelDef,
      providerId,
      buildPositiveIntegerSetting(modelSettings?.maxOutputTokens) ??
        buildPositiveIntegerSetting(settings?.maxOutputTokens)
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
/**
 * Direct-OpenAI counterpart (BST-1709). The rows declare their own ladders,
 * and those differ: the Pro rows take only medium, high and xhigh, while the
 * GPT-5.6 rows add none and max. So a provider-wide effort chosen on one model
 * can be one the next model rejects. Clear it on the switch so the controls
 * show what the request sends. An undeclared or uncatalogued model is left
 * alone: there is no ladder to judge against.
 */
function reconcileOpenAiSettingsForModel(
  modelName: string,
  settings: AssistantProviderSettings
): AssistantProviderSettings {
  const effort = settings.reasoningEffort;
  const ladder = effort ? findLlmModelDefinition('openai', modelName)?.reasoning : undefined;
  if (!(effort && ladder) || ladder.supportedEfforts.includes(effort)) {
    return settings;
  }
  const { reasoningEffort: _unsupportedReasoningEffort, ...compatibleSettings } = settings;
  return compatibleSettings;
}

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
  if (providerId === 'openai' && settings) {
    return reconcileOpenAiSettingsForModel(modelName, settings);
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
