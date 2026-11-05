import {
  type AnthropicProviderOptions,
  BEDROCK_BUDGET_TOKENS_BY_EFFORT,
  BEDROCK_REASONING_EFFORTS,
  type BedrockProviderOptions,
  DESKTOP_NATIVE_TOOL_IDS,
  type DesktopNativeToolId,
  deriveAgentLoopInputTokenLimit,
  deriveEffectiveInputBudget,
  findLlmModelDefinition,
  type GoogleProviderOptions,
  getLlmModelDefinition,
  listProviderLlmModels,
  mergeOpenRouterAutoProfileModel,
  type OpenAiProviderOptions,
  type OpenRouterAutoProfileModel,
  type OpenRouterModelMetadata,
  type OpenRouterModelMetadataLookup,
  type OpenRouterProviderOptions,
  type ProviderKeySource,
  type RuntimeData,
  resolveBedrockReasoningDisplay,
  resolveOpenRouterAutoRuntimeProfile,
  resolveOpenRouterCodingMaxOutputTokens,
  resolveOpenRouterOutputWindow,
  resolveOpenRouterReasoningActive,
  resolveReasoningVisible,
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

/** Why an OpenRouter model cannot take a reasoning effort, or undefined when it can. */
function openRouterReasoningEffortIssue(
  modelName: string,
  reasoningEffort: NonNullable<AssistantProviderSettings['reasoningEffort']>,
  metadata: OpenRouterModelMetadata | undefined
): string | undefined {
  const model = getLlmModelDefinition('openrouter', modelName);
  const label = model.label ?? model.id;
  const reasoning =
    metadata?.id === modelName && metadata.reasoning ? metadata.reasoning : model.reasoning;
  if (!reasoning) {
    return `OpenRouter model "${label}" does not declare support for reasoning effort "${reasoningEffort}".`;
  }
  if (reasoningEffort === 'none') {
    return reasoning.mandatory
      ? `OpenRouter model "${label}" does not support reasoning effort "${reasoningEffort}".`
      : undefined;
  }
  const supportedEfforts = reasoning.supportedEfforts;
  if (!supportedEfforts) {
    return `OpenRouter model "${label}" does not declare support for reasoning effort "${reasoningEffort}".`;
  }
  if (!supportedEfforts.includes(reasoningEffort)) {
    return `OpenRouter model "${label}" does not support reasoning effort "${reasoningEffort}". Supported efforts: ${supportedEfforts.join(', ')}.`;
  }
  return;
}

function assertOpenRouterReasoningEffortSupported(
  modelName: string,
  reasoningEffort: NonNullable<AssistantProviderSettings['reasoningEffort']>,
  metadata: OpenRouterModelMetadata | undefined
): void {
  const issue = openRouterReasoningEffortIssue(modelName, reasoningEffort, metadata);
  if (issue) {
    throw new Error(issue);
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
 *
 * BST-1706: `mandatory` (always-on thinking, e.g. Fable) short-circuits both
 * legacy shapes — a persisted budget from another model is dropped, never
 * forwarded, and `disabled` is never sent because the vendor rejects it. For
 * toggleable ladder rows, cleared settings explicitly disable:
 * `mandatory: false` is the derived license for `disabled`, retiring the old
 * Opus-5-only id check. It is load-bearing for the rows that think when
 * options are omitted (Opus 5, Sonnet 5) — omitting would leave them thinking
 * while the cleared toggle reads off — and equivalent to omitting for the
 * default-off rows. Rows without a ladder (Haiku, uncatalogued) keep the
 * legacy omit, whose shape no flag derives.
 */
function resolveAnthropicThinkingShape(input: {
  budgetTokens: number | undefined;
  effort: AssistantProviderSettings['anthropicEffort'];
  hasLadder: boolean;
  mandatory: boolean;
  showReasoning: boolean;
}): AnthropicProviderOptions['thinking'] | undefined {
  if (input.mandatory) {
    // BST-1804: sent at EVERY effort, Auto included. Anthropic documents that
    // these rows think with no configuration, that `{type: "adaptive"}` needs
    // no effort, and that `display` defaults to `omitted` on them — so an
    // omitted `thinking` hides the show-reasoning preference, and on Opus 5.5
    // the between-tool-call progress text it returns in thinking blocks.
    // Auto still sends no effort: the vendor default applies.
    return {
      display: input.showReasoning ? 'summarized' : 'omitted',
      type: 'adaptive',
    };
  }
  if (typeof input.budgetTokens === 'number') {
    return {
      budgetTokens: Math.floor(input.budgetTokens),
      type: 'enabled',
    };
  }
  if (input.effort !== undefined) {
    return {
      display: input.showReasoning ? 'summarized' : 'omitted',
      type: 'adaptive',
    };
  }
  return input.hasLadder ? { type: 'disabled' } : undefined;
}

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
  // provider-side — the reason Claude runs showed no thinking at all. Emitted
  // alongside a chosen effort, and at Auto for always-on (`mandatory`) rows.
  //
  // Thinking-shape rules (mandatory short-circuit, explicit disable on
  // clear) live on resolveAnthropicThinkingShape above. `hasLadder` is
  // exactly "the row declares an `anthropicReasoning` catalog block".
  const thinking = resolveAnthropicThinkingShape({
    budgetTokens: settings.anthropicThinkingBudgetTokens,
    effort,
    hasLadder: reasoning !== undefined,
    mandatory: reasoning?.mandatory ?? false,
    showReasoning: resolveReasoningVisible(settings),
  });
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
  if (!modelName) {
    return;
  }
  // Keyed on the UNPREFIXED catalog id, which is all this seam can receive:
  // both the registry and the DB model catalog (migration 100) store Bedrock
  // ids unprefixed, and the cross-region routing prefix is applied per request
  // inside packages/agent. The agent-side capability lookup resolves a routed
  // id back to its catalog row for the same reason; if a prefixed id ever
  // reaches HERE, that invariant has already broken upstream.
  const definition = findLlmModelDefinition('bedrock', modelName);
  const dialect = definition?.bedrockReasoning;
  const effort = settings.bedrockEffort;
  const offered =
    dialect !== undefined && effort !== undefined
      ? BEDROCK_REASONING_EFFORTS[dialect].includes(effort)
      : false;
  if (dialect === 'adaptive' && definition?.bedrockReasoningMandatory) {
    // BST-1807, as BST-1804 did for the direct rows: an always-thinking route
    // gets adaptive thinking at EVERY effort, Auto included. Its `display`
    // defaults to `omitted`, so leaving the config out hides the
    // show-reasoning preference, and on Opus 5.5 the between-tool-call
    // progress text it returns as thinking. Auto, or an effort this route
    // does not offer, sends no effort: the vendor default applies.
    return {
      reasoningConfig: {
        display: resolveBedrockReasoningDisplay(settings),
        ...(offered && effort !== undefined ? { maxReasoningEffort: effort } : {}),
        type: 'adaptive',
      },
    };
  }
  if (!(dialect && effort && offered)) {
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
