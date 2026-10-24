import type { OpenAiReasoningEffort } from './runtime-data.ts';

/**
 * OpenCode's coding-oriented output ceiling. OpenRouter models with a smaller
 * advertised completion limit use that limit instead.
 */
export const OPENROUTER_CODING_MAX_OUTPUT_TOKENS = 32_000;

export interface OpenRouterAutoRuntimeProfile {
  readonly maxOutputTokens: number;
  readonly reasoningEffort?: OpenAiReasoningEffort;
}

export interface OpenRouterAutoProfileModel {
  readonly id: string;
  readonly maxOutputTokens?: number;
  readonly reasoning?: {
    /**
     * The effort the zero-configuration Auto profile sends for this model.
     *
     * Recorded per model in our catalog and takes precedence over the vendor's
     * `defaultEffort`. This is the ONLY place an Auto effort may deviate from
     * what the vendor declares — write it down here rather than deriving it,
     * including `'none'` when reasoning should deliberately be switched off.
     */
    readonly autoEffort?: OpenAiReasoningEffort;
    readonly defaultEffort?: OpenAiReasoningEffort;
    readonly defaultEnabled?: boolean;
    readonly mandatory?: boolean;
    readonly supportedEfforts?: readonly OpenAiReasoningEffort[];
    readonly supportsMaxTokens?: boolean;
    /**
     * Vendor-documented completion window sized for thinking + answer.
     * Catalog-only, like `autoEffort` — OpenRouter does not publish it. See
     * `resolveOpenRouterOutputWindow` (BST-1170).
     */
    readonly vendorDefaultOutputTokens?: number;
  };
}

/**
 * Small, deliberately diverse coding set enabled when a readable OpenRouter
 * configuration first meets an untouched model catalog. Each route is part of
 * the supported static registry and has passed a live assistant/tooling smoke.
 */
export const OPENROUTER_RECOMMENDED_CODING_MODEL_IDS = [
  'openai/gpt-5.6-terra',
  'moonshotai/kimi-k3',
  'qwen/qwen3.7-max',
  'z-ai/glm-5.2',
  'minimax/minimax-m3',
] as const;

export function resolveOpenRouterCodingMaxOutputTokens(modelMaxOutputTokens?: number): number {
  if (modelMaxOutputTokens === undefined) {
    return OPENROUTER_CODING_MAX_OUTPUT_TOKENS;
  }
  if (!(Number.isSafeInteger(modelMaxOutputTokens) && modelMaxOutputTokens > 0)) {
    throw new Error(`modelMaxOutputTokens must be a positive integer, got ${modelMaxOutputTokens}`);
  }
  return Math.min(modelMaxOutputTokens, OPENROUTER_CODING_MAX_OUTPUT_TOKENS);
}

/**
 * Whether the request that will actually reach OpenRouter reasons. An explicit
 * effort choice wins outright; otherwise the model's declared Auto resolution
 * decides (`defaultEnabled`, with `autoEffort: 'none'` as the recorded off
 * switch). Mirrors `buildOpenRouterOptions`' effort resolution so the output
 * window is sized for the same request it accompanies.
 */
export function resolveOpenRouterReasoningActive(
  model: OpenRouterAutoProfileModel,
  explicitEffort?: OpenAiReasoningEffort
): boolean {
  if (explicitEffort !== undefined) {
    return explicitEffort !== 'none';
  }
  const reasoning = model.reasoning;
  if (!reasoning?.defaultEnabled) {
    return false;
  }
  return reasoning.autoEffort !== 'none';
}

/**
 * Effective `max_tokens` for an OpenRouter request (BST-1170).
 *
 * OpenRouter documents that reasoning tokens ARE output tokens and that a
 * requested effort allocates a share OF `max_tokens` for reasoning (high ≈
 * 80%, max/xhigh ≈ 95%) — so the 32K coding ceiling does not protect the
 * final answer on reasoning runs; it shrinks the whole thinking+answer
 * window. When reasoning is active and the catalog records the vendor's own
 * documented completion window (`vendorDefaultOutputTokens`), that window is
 * used instead, capped only by a declared model completion limit. Models
 * without the recorded fact keep the coding ceiling — sizing beyond the
 * ceiling requires a vendor-documented number, never an inference.
 */
export function resolveOpenRouterOutputWindow(
  model: OpenRouterAutoProfileModel,
  reasoningActive: boolean
): number {
  const ceiling = resolveOpenRouterCodingMaxOutputTokens(model.maxOutputTokens);
  if (!reasoningActive) {
    return ceiling;
  }
  const vendorWindow = model.reasoning?.vendorDefaultOutputTokens;
  if (vendorWindow === undefined) {
    return ceiling;
  }
  if (!(Number.isSafeInteger(vendorWindow) && vendorWindow > 0)) {
    throw new Error(
      `${model.id}: reasoning.vendorDefaultOutputTokens must be a positive integer, got ${vendorWindow}`
    );
  }
  return model.maxOutputTokens === undefined
    ? vendorWindow
    : Math.min(vendorWindow, model.maxOutputTokens);
}

/**
 * Overlay our catalog's Auto override onto a live metadata snapshot.
 *
 * `autoEffort` is OURS — OpenRouter does not publish it, so
 * `OpenRouterModelMetadata` structurally cannot carry it. Callers that pick
 * live metadata *instead of* the catalog therefore drop the override, which is
 * exactly how `moonshotai/kimi-k3` would fall from its recorded `low` back to
 * the vendor's `max` the moment a key resolves live metadata. Vendor-published
 * facts still win; only the catalog-only override is merged in.
 *
 * Use this at every site that feeds live metadata to
 * `resolveOpenRouterAutoRuntimeProfile`.
 */
export function mergeOpenRouterAutoProfileModel(
  live: OpenRouterAutoProfileModel | undefined,
  catalog: OpenRouterAutoProfileModel | undefined
): OpenRouterAutoProfileModel | undefined {
  if (!live) {
    return catalog;
  }
  const catalogReasoning = catalog?.reasoning;
  // The catalog-only facts OpenRouter structurally cannot publish. Vendor
  // facts still win; only these overlays are merged in.
  const catalogOnly = {
    ...(catalogReasoning?.autoEffort === undefined
      ? {}
      : { autoEffort: catalogReasoning.autoEffort }),
    ...(catalogReasoning?.vendorDefaultOutputTokens === undefined
      ? {}
      : { vendorDefaultOutputTokens: catalogReasoning.vendorDefaultOutputTokens }),
  };
  // Nothing to carry, or live says this model does not reason at all — in
  // which case the overlays are moot and live remains authoritative.
  if (!(Object.keys(catalogOnly).length > 0 && live.reasoning)) {
    return live;
  }
  return {
    ...live,
    reasoning: { ...live.reasoning, ...catalogOnly },
  };
}

export function resolveOpenRouterAutoRuntimeProfile<TModel extends OpenRouterAutoProfileModel>(
  model: TModel,
  configuredMaxOutputTokens?: number
): OpenRouterAutoRuntimeProfile {
  // The window is sized for the same reasoning resolution this profile sends:
  // an active-reasoning Auto request gets the vendor-documented window when
  // the catalog records one (BST-1170). An explicit configured limit stays
  // authoritative.
  const baselineOutputTokens =
    configuredMaxOutputTokens ??
    resolveOpenRouterOutputWindow(model, resolveOpenRouterReasoningActive(model));
  if (
    configuredMaxOutputTokens !== undefined &&
    !(Number.isSafeInteger(configuredMaxOutputTokens) && configuredMaxOutputTokens > 0)
  ) {
    throw new Error(
      `configuredMaxOutputTokens must be a positive integer, got ${configuredMaxOutputTokens}`
    );
  }
  const reasoning = model.reasoning;
  if (!reasoning?.defaultEnabled) {
    return { maxOutputTokens: baselineOutputTokens };
  }

  // DECLARED ONLY — never inferred (BST-833). The previous rule scanned
  // `supportedEfforts` for a "completion-biased" effort and, finding none,
  // silently substituted `none`, discarding the model's own declared default.
  // GLM-5.2 declares `defaultEffort: 'high'` and advertises no low tier, so it
  // lost reasoning entirely — invisibly, and for a reason unrelated to any
  // measured budget risk. The final-answer budget is protected by
  // OPENROUTER_CODING_MAX_OUTPUT_TOKENS above, which is independent of effort.
  //
  // A model that should reason less (or not at all) under Auto records that as
  // `autoEffort` in the catalog. With neither field declared we have no basis
  // for a claim, so we send no effort at all and let the provider apply its
  // own default — inventing one here is exactly the silent fallback this
  // removes.
  const autoEffort = reasoning.autoEffort;
  if (autoEffort) {
    // The Auto path bypasses `assertOpenRouterReasoningEffortSupported`, which
    // only guards explicit user choices. Validate here so a bad catalog entry
    // fails at its source instead of on the wire — under
    // `provider.require_parameters` OpenRouter fails routing rather than
    // ignoring an unsupported hint, which would surface far from the cause.
    if (autoEffort === 'none') {
      if (reasoning.mandatory === true) {
        throw new Error(
          `${model.id}: autoEffort 'none' is invalid for a model whose reasoning is mandatory.`
        );
      }
    } else if (reasoning.supportedEfforts && !reasoning.supportedEfforts.includes(autoEffort)) {
      throw new Error(
        `${model.id}: autoEffort '${autoEffort}' is not in supportedEfforts [${reasoning.supportedEfforts.join(', ')}].`
      );
    }
  }
  const declaredEffort = autoEffort ?? reasoning.defaultEffort;
  return {
    maxOutputTokens: baselineOutputTokens,
    ...(declaredEffort ? { reasoningEffort: declaredEffort } : {}),
  };
}
