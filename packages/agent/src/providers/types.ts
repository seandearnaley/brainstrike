/**
 * Supported AI providers
 */
export type SupportedProvider = 'openai' | 'anthropic' | 'google' | 'openrouter';

/**
 * Provider display names
 */
export const PROVIDER_DISPLAY_NAMES: Record<SupportedProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  openrouter: 'OpenRouter',
} as const;

/**
 * Check if a provider is supported
 */
export function isSupportedProvider(provider: string | undefined): provider is SupportedProvider {
  if (!provider) return false;
  return ['openai', 'anthropic', 'google', 'openrouter'].includes(provider);
}

/**
 * Get a display-friendly name for a provider.
 */
export function getProviderDisplayName(provider: SupportedProvider | string): string {
  return PROVIDER_DISPLAY_NAMES[provider as SupportedProvider] ?? provider;
}

/**
 * Curated model lists per provider.
 *
 * Note: AI SDK doesn't provide runtime model listing APIs, so we maintain
 * sensible defaults for each provider. Users can override with custom model names.
 */
export const PROVIDER_MODELS: Record<SupportedProvider, readonly string[]> = {
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'] as const,
  anthropic: [
    'claude-3-5-sonnet-latest',
    'claude-3-5-haiku-latest',
    'claude-3-opus-latest',
  ] as const,
  google: ['gemini-2.5-flash', 'gemini-2.0-pro', 'gemini-1.5-pro'] as const,
  openrouter: ['gpt-4o', 'gpt-4o-mini', 'claude-3-5-sonnet'] as const,
} as const;

/**
 * Default models per provider
 */
export const PROVIDER_DEFAULT_MODELS: Record<SupportedProvider, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  google: 'gemini-2.5-flash',
  openrouter: 'gpt-4o-mini',
} as const;

/**
 * Get available models for a given provider.
 */
export function getProviderModels(provider: SupportedProvider | string): readonly string[] {
  if (provider in PROVIDER_MODELS) {
    return PROVIDER_MODELS[provider as SupportedProvider];
  }
  return [];
}

/**
 * Get the default model for a given provider.
 */
export function getProviderDefaultModel(provider: SupportedProvider | string): string | undefined {
  if (provider in PROVIDER_DEFAULT_MODELS) {
    return PROVIDER_DEFAULT_MODELS[provider as SupportedProvider];
  }
  return undefined;
}

/**
 * Check if a model is valid for a given provider.
 */
export function isValidModelForProvider(
  provider: SupportedProvider | string,
  model: string
): boolean {
  const models = getProviderModels(provider);
  return models.includes(model);
}
