/**
 * Cross-provider resolution of "should the provider return the model's
 * reasoning?".
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
