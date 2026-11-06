/**
 * A model's generation options from a person's per-provider settings: the
 * request's `modelSettings` and the `providerOptions` each provider's SDK
 * reads (reasoning effort, thinking shape, visibility). Pure functions over
 * the catalog, so the composer builds a run's options and the host builds a
 * delegated child's with one implementation.
 */
import { type AssistantProviderSettings, getGoogleThinkingLevels } from '@brainstrike/types';
import { BEDROCK_BUDGET_TOKENS_BY_EFFORT, BEDROCK_REASONING_EFFORTS } from './model-reasoning.ts';
import {
  mergeOpenRouterAutoProfileModel,
  type OpenRouterAutoProfileModel,
  resolveOpenRouterAutoRuntimeProfile,
  resolveOpenRouterCodingMaxOutputTokens,
  resolveOpenRouterOutputWindow,
  resolveOpenRouterReasoningActive,
} from './openrouter-coding-defaults.ts';
import type { OpenRouterModelMetadata } from './openrouter-model-metadata.ts';
import type { SupportedProvider } from './provider-metadata.ts';
import {
  findLlmModelDefinition,
  getLlmModelDefinition,
  listProviderLlmModels,
} from './provider-registry.ts';
import { resolveBedrockReasoningDisplay, resolveReasoningVisible } from './reasoning-visibility.ts';
import type {
  AnthropicProviderOptions,
  BedrockProviderOptions,
  GoogleProviderOptions,
  OpenAiProviderOptions,
  OpenRouterProviderOptions,
  RuntimeData,
} from './runtime-data.ts';

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

export function buildModelSettings(
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
export function openRouterReasoningEffortIssue(
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

/** The catalog limits an OpenRouter output window is sized against. */
export interface SelectedModelBudgetDef {
  contextWindow: number;
  maxOutputTokens?: number;
}

/** An OpenRouter model's catalog row, as the output-window rules read it. */
export function findOpenRouterCatalogModel(
  modelId: string
): OpenRouterAutoProfileModel | undefined {
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

/**
 * A request's model settings as the composer sends them: the person's own,
 * and for OpenRouter an output limit sized to the model and its reasoning
 * state when they set none (the admission's input budget is derived from it).
 */
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
