import { BEDROCK_RECOMMENDED_MODEL_IDS } from './bedrock-defaults.js';
import { OPENAI_CODEX_RECOMMENDED_MODEL_IDS } from './openai-codex-defaults.js';
import { OPENROUTER_RECOMMENDED_CODING_MODEL_IDS } from './openrouter-coding-defaults.js';
import type { SupportedProvider } from './provider-metadata.js';

/**
 * How a provider's DB catalog rows become enabled without the user (BST-1794).
 *
 * - `all` is an AVAILABILITY policy: every LLM row is on unless the user said
 *   otherwise. Standing — re-evaluated each app session, so a model added by a
 *   later migration becomes reachable with no further edits. This is what makes
 *   a catalog addition reach an existing profile.
 * - `seed` is a STARTER KIT: a curated list applied once, only while the
 *   provider's rows are entirely untouched. Re-applying a curated subset over a
 *   profile the user has already curated would be presumptuous, so `seed` keeps
 *   the original provider-wide gate.
 *
 * Consequence recorded deliberately: OpenRouter routes added after the seed
 * (e.g. `deepseek/deepseek-v4.1-flash`) stay opt-in. Under a starter kit that
 * is correct, not residue.
 */
export type ProviderModelDefaultPolicy =
  | { readonly kind: 'all' }
  | { readonly kind: 'seed'; readonly modelIds: readonly string[] };

/**
 * Exhaustive over `SupportedProvider`. `null` means the provider has no catalog
 * defaults at all, which is true exactly when it is keyless (enablement comes
 * from runtime discovery and the downloaded-model set) or serves no LLMs.
 *
 * The `satisfies` is load-bearing: a new provider cannot compile without
 * stating a policy or an explicit `null`. Omitting that decision is what left
 * seven models unreachable in the first place. The `null`-iff rule is pinned by
 * provider-model-default-policies.test.ts against the live catalog rather than
 * restated here as a hand-maintained list.
 */
export const PROVIDER_MODEL_DEFAULT_POLICIES = {
  anthropic: { kind: 'all' },
  bedrock: { kind: 'seed', modelIds: BEDROCK_RECOMMENDED_MODEL_IDS },
  cohere: null,
  google: { kind: 'all' },
  lmstudio: null,
  local: null,
  ollama: null,
  openai: { kind: 'all' },
  'openai-codex': { kind: 'seed', modelIds: OPENAI_CODEX_RECOMMENDED_MODEL_IDS },
  openrouter: { kind: 'seed', modelIds: OPENROUTER_RECOMMENDED_CODING_MODEL_IDS },
  voyage: null,
} as const satisfies Record<SupportedProvider, ProviderModelDefaultPolicy | null>;

/** Non-throwing accessor; `null` for a provider with no catalog defaults. */
export function getProviderModelDefaultPolicy(
  provider: SupportedProvider
): ProviderModelDefaultPolicy | null {
  return PROVIDER_MODEL_DEFAULT_POLICIES[provider];
}
