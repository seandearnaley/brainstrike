/**
 * OpenAI Codex (ChatGPT subscription) DB-catalog enablement defaults
 * (BST-1356).
 *
 * Migration 102 seeds every `openai-codex` model row `is_enabled = false`,
 * mirroring the openrouter and bedrock seeds. Enablement comes from
 * `useProviderModelDefaults` (packages/app-shell), selected via
 * `PROVIDER_MODEL_DEFAULT_POLICIES` as a `seed` policy — exactly like those
 * seeds — which runs this set through the idempotent, user-choice-preserving
 * `initializeProviderModelDefaults` action the first time a connected
 * subscription credential is present. Ids must exist in the static registry's
 * `openai-codex` entry (pinned by openai-codex-defaults.test.ts) and carry
 * the `codex/` catalog prefix.
 */
export const OPENAI_CODEX_RECOMMENDED_MODEL_IDS = ['codex/gpt-5.5', 'codex/gpt-5.4-mini'] as const;
