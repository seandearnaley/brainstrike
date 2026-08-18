/**
 * Shared resolution of "should the provider return the model's reasoning?".
 *
 * The MEANING is uniform across providers; the storage is not — like every
 * assistant setting this lives under `providerSettings[providerId]`, so it is
 * set independently per provider.
 *
 * Reasoning has two independent dimensions, and conflating them is what made
 * every provider behave differently:
 *
 * - DEPTH — how hard the model thinks (`reasoningEffort`, `anthropicEffort`,
 *   `googleThinkingLevel`, an OpenRouter auto profile). A budget concern.
 * - VISIBILITY — whether that thinking is streamed back to us. A UX concern.
 *
 * Before this module each provider expressed visibility differently and each
 * defaulted to silence for a different reason: OpenAI needed an unset
 * `reasoningSummary`, Google an unset `includeThoughts`, Anthropic's `display`
 * defaults to `omitted` provider-side, and the OpenRouter auto profile turned
 * reasoning off wholesale to protect the final-answer budget. Four providers,
 * four ways to end up with an empty thinking disclosure.
 *
 * This resolver owns the default. Provider-specific keys stay valid escape
 * hatches and win when explicitly set — the default only fills the silence.
 */

/**
 * Reasoning is visible unless the user says otherwise. A model that thinks and
 * then hides it reads as a stall, and the disclosure has nothing to reveal.
 */
export const DEFAULT_REASONING_VISIBLE = true;

export interface ReasoningVisibilitySettings {
  readonly reasoningVisible?: boolean;
}

/** Whether the runtime should ask this provider to return reasoning. */
export function resolveReasoningVisible(settings?: ReasoningVisibilitySettings): boolean {
  return settings?.reasoningVisible ?? DEFAULT_REASONING_VISIBLE;
}

/**
 * Bedrock's projection of the shared switch (BST-1354).
 *
 * Bedrock expresses visibility as `reasoningConfig.display`, the same
 * `omitted`/`summarized` vocabulary first-party Anthropic uses — and with the
 * same provider-side default of `omitted`, so a Bedrock run that is not asked
 * for its thinking returns none and the disclosure sits empty.
 *
 * Honored by the SDK ONLY for the `adaptive` config type. The other two Bedrock
 * dialects have no visibility knob at all: legacy `enabled` + `budgetTokens`
 * always returns thinking blocks, and Amazon Nova returns redacted reasoning
 * regardless. Callers therefore attach this to the adaptive dialect only —
 * mirroring the existing first-party rule that the legacy budget form carries
 * no `display`. That is an absent knob, not an ignored setting.
 */
export function resolveBedrockReasoningDisplay(
  settings?: ReasoningVisibilitySettings
): 'omitted' | 'summarized' {
  return resolveReasoningVisible(settings) ? 'summarized' : 'omitted';
}
