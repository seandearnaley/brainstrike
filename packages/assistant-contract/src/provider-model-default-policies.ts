import { BEDROCK_RECOMMENDED_MODEL_IDS } from './bedrock-defaults.ts';
import { OPENROUTER_RECOMMENDED_CODING_MODEL_IDS } from './openrouter-coding-defaults.ts';
import type { SupportedProvider } from './provider-metadata.ts';

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
 * Exhaustive over `SupportedProvider`.
 *
 * The `satisfies` is load-bearing: a new provider cannot compile without
 * stating a policy. Omitting that decision is what left seven models
 * unreachable in the first place.
 */
export const PROVIDER_MODEL_DEFAULT_POLICIES = {
  anthropic: { kind: 'all' },
  bedrock: { kind: 'seed', modelIds: BEDROCK_RECOMMENDED_MODEL_IDS },
  chatgpt: { kind: 'all' },
  google: { kind: 'all' },
  openai: { kind: 'all' },
  openrouter: { kind: 'seed', modelIds: OPENROUTER_RECOMMENDED_CODING_MODEL_IDS },
} as const satisfies Record<SupportedProvider, ProviderModelDefaultPolicy>;

export function getProviderModelDefaultPolicy(
  provider: SupportedProvider
): ProviderModelDefaultPolicy {
  return PROVIDER_MODEL_DEFAULT_POLICIES[provider];
}
