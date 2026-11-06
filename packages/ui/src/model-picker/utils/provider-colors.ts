import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';

interface ProviderColorPair {
  readonly dark: string;
  readonly light: string;
}

/**
 * Every static registry provider has an explicit entry — pinned at COMPILE
 * time by the `satisfies Record<SupportedProvider, ...>` below (BST-1349,
 * PR #2513 review finding 6): adding a provider to the registry without a
 * color here is a type error. Any other id gets the muted text colour: a
 * provider's colour is its identity, so none is derived from a hash
 * (docs/agents/ui-conventions.md).
 */
export const PROVIDER_COLOR_MAP: Record<string, ProviderColorPair> = {
  anthropic: { dark: 'hsl(25, 70%, 55%)', light: 'hsl(25, 70%, 45%)' },
  // AWS-orange family (#FF9900 ≈ 36°); saturation pushed well above
  // anthropic's 25°/70% so the two orange dots stay distinguishable at
  // swatch size.
  bedrock: { dark: 'hsl(36, 95%, 55%)', light: 'hsl(36, 95%, 38%)' },
  google: { dark: 'hsl(210, 70%, 55%)', light: 'hsl(210, 70%, 45%)' },
  openai: { dark: 'hsl(160, 60%, 50%)', light: 'hsl(160, 60%, 35%)' },
  openrouter: { dark: 'hsl(280, 60%, 55%)', light: 'hsl(280, 60%, 45%)' },
} satisfies Record<SupportedProvider, ProviderColorPair>;

export function getProviderColor(providerId: string, theme: 'light' | 'dark'): string {
  if (PROVIDER_COLOR_MAP[providerId]) {
    return PROVIDER_COLOR_MAP[providerId][theme];
  }
  return UNKNOWN_PROVIDER_COLOR;
}

/** The muted text colour of the active theme, for a provider without a registry colour. */
export const UNKNOWN_PROVIDER_COLOR = 'var(--bs-muted-foreground)';
