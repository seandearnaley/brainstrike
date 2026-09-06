/**
 * Amazon Bedrock DB-catalog enablement defaults (BST-1350, review finding 8).
 *
 * Migration 100 seeds every bedrock model row `is_enabled = false`, mirroring
 * the openrouter seed. Enablement comes from `useBedrockDefaults`
 * (packages/app-shell), which — exactly like openrouter's hook — runs this
 * set through the idempotent, user-choice-preserving
 * `initializeProviderModelDefaults` action the first time a readable bedrock
 * configuration is present. Ids must exist in the static registry's bedrock
 * entry (pinned by bedrock-defaults.test.ts).
 */
export const BEDROCK_RECOMMENDED_MODEL_IDS = [
  'anthropic.claude-sonnet-5',
  'anthropic.claude-haiku-4-5-20251001-v1:0',
] as const;
