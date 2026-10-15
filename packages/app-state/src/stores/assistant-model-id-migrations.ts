import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';

export const MODEL_ID_MIGRATIONS: Readonly<
  Record<SupportedProvider, Readonly<Record<string, string>>>
> = {
  anthropic: {
    'claude-3-5-haiku-20241022': 'claude-haiku-4-5',
    'claude-3-5-haiku-latest': 'claude-haiku-4-5',
    'claude-3-5-sonnet-latest': 'claude-sonnet-4-6',
    'claude-3-opus-latest': 'claude-opus-4-8',
    'claude-opus-4-1-20250805': 'claude-opus-4-8',
    'claude-opus-4-5': 'claude-opus-4-8',
    'claude-opus-4-5-20251101': 'claude-opus-4-8',
    // Superseded 4-5 generation aliases.
    'claude-sonnet-4-5': 'claude-sonnet-4-6',
    'claude-sonnet-4-5-20250929': 'claude-sonnet-4-6',
    'claude-sonnet-4-20250514': 'claude-sonnet-4-6',
  },
  bedrock: {},
  cohere: {},
  google: {
    'gemini-1.5-pro': 'gemini-2.5-pro',
    // gemini-2.5-flash / gemini-2.5-pro are now first-class models — do not
    // remap them away.
    'gemini-2.0-pro': 'gemini-2.5-pro',
    'gemini-3-flash-preview': 'gemini-3.5-flash',
    'gemini-3-pro-preview': 'gemini-3.1-pro-preview',
  },
  lmstudio: {},
  local: {},
  ollama: {},
  openai: {
    'gpt-3.5-turbo': 'gpt-5.4-mini',
    'gpt-4-turbo': 'gpt-5.4',
    'gpt-4o': 'gpt-5.4',
    'gpt-4o-mini': 'gpt-5.4-mini',
    // gpt-5.2-chat-latest dropped (docs: not recommended for API use).
    'gpt-5.2-chat-latest': 'gpt-5.4',
  },
  // BST-1356: a brand-new provider has no historical model ids to remap.
  'openai-codex': {},
  openrouter: {
    'anthropic/claude-3.5-sonnet': 'anthropic/claude-sonnet-4.6',
    'anthropic/claude-opus-4.5': 'anthropic/claude-opus-4.8',
    'anthropic/claude-sonnet-4.5': 'anthropic/claude-sonnet-4.6',
    'google/gemini-1.5-pro': 'google/gemini-2.5-flash',
    'google/gemini-2.0-pro': 'google/gemini-2.5-flash',
    // Legacy Google Pro IDs map to Flash here (not Pro like the direct-provider
    // map) because google/gemini-2.5-pro is not in the OpenRouter catalog —
    // including google/gemini-2.5-pro itself (a stale FROM key for users who
    // skipped the v5 migration).
    'google/gemini-2.5-pro': 'google/gemini-2.5-flash',
    'google/gemini-3-flash-preview': 'google/gemini-3.5-flash',
    'google/gemini-3-pro-preview': 'google/gemini-3.1-pro-preview',
    // BST-1697 — four ids delisted from the OpenRouter models API (checked
    // 2026-09-09). The free routes remap to PAID replacements, so each of
    // these lands a user-visible notice when it is the selected model.
    //
    // Ling 3.0 Flash was free and text-only; BST-1702 added the like-for-like
    // paid `inclusionai/ling-3.0-flash` (same 262,144 context, text-only, a
    // quarter of Nemotron's price), so the retired `:free` route remaps
    // there, not to the Nemotron stopgap.
    'inclusionai/ling-3.0-flash:free': 'inclusionai/ling-3.0-flash',
    // Same family, identical 256,000 / 80,000 / text-only shape.
    'kwaipilot/kat-coder-air-v2.5': 'kwaipilot/kat-coder-pro-v2.5',
    'openai/gpt-3.5-turbo': 'openai/gpt-5.4-mini',
    'openai/gpt-4-turbo': 'openai/gpt-5.4',
    'openai/gpt-4o': 'openai/gpt-5.4',
    'openai/gpt-4o-mini': 'openai/gpt-5.4-mini',
    'openrouter/claude-3-5-sonnet': 'anthropic/claude-sonnet-4.6',
    'openrouter/gpt-4o': 'openai/gpt-5.4',
    'openrouter/gpt-4o-mini': 'openai/gpt-5.4-mini',
    // Dated snapshot replacement with identical context, output ceiling,
    // vision and pricing (added by BST-1695).
    'qwen/qwen3.8-max': 'qwen/qwen3.8-max-0902',
    // Ox Alpha was free AND vision-capable. Every cheaper OpenRouter row we
    // ship is text-only, so this picks the cheapest CAPABILITY-PRESERVING
    // replacement rather than the cheapest one: 1,048,576 -> 1,000,000
    // context, 131,072 output unchanged, vision preserved.
    'stealth/ox-alpha': 'qwen/qwen3.8-flash',
  },
  voyage: {},
};

export function getModelIdMigrationTarget(
  provider: SupportedProvider | undefined,
  modelId: string
): string | null {
  if (!provider) {
    return null;
  }
  const migrations = MODEL_ID_MIGRATIONS[provider];
  if (!Object.hasOwn(migrations, modelId)) {
    return null;
  }
  return migrations[modelId] ?? null;
}

export function isRetiredModelId(
  provider: SupportedProvider | undefined,
  modelId: string
): boolean {
  return provider !== undefined && Object.hasOwn(MODEL_ID_MIGRATIONS[provider], modelId);
}
