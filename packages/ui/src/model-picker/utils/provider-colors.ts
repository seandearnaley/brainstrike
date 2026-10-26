import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';

interface ProviderColorPair {
  readonly dark: string;
  readonly light: string;
}

/**
 * Every static registry provider has an explicit entry — pinned at COMPILE
 * time by the `satisfies Record<SupportedProvider, ...>` below (BST-1349,
 * PR #2513 review finding 6): adding a provider to the registry without a
 * color here is a type error. The hash fallback in `getProviderColor` covers
 * catalog provider ids outside the registry.
 */
export const PROVIDER_COLOR_MAP: Record<string, ProviderColorPair> = {
  anthropic: { dark: 'hsl(25, 70%, 55%)', light: 'hsl(25, 70%, 45%)' },
  // AWS-orange family (#FF9900 ≈ 36°); saturation pushed well above
  // anthropic's 25°/70% so the two orange dots stay distinguishable at
  // swatch size.
  bedrock: { dark: 'hsl(36, 95%, 55%)', light: 'hsl(36, 95%, 38%)' },
  cohere: { dark: 'hsl(340, 60%, 55%)', light: 'hsl(340, 60%, 45%)' },
  google: { dark: 'hsl(210, 70%, 55%)', light: 'hsl(210, 70%, 45%)' },
  openai: { dark: 'hsl(160, 60%, 50%)', light: 'hsl(160, 60%, 35%)' },
  openrouter: { dark: 'hsl(280, 60%, 55%)', light: 'hsl(280, 60%, 45%)' },
  voyage: { dark: 'hsl(180, 60%, 50%)', light: 'hsl(180, 60%, 35%)' },
} satisfies Record<SupportedProvider, ProviderColorPair>;

export function getProviderColor(providerId: string, theme: 'light' | 'dark'): string {
  if (PROVIDER_COLOR_MAP[providerId]) {
    return PROVIDER_COLOR_MAP[providerId][theme];
  }
  // Fallback: hash-based color
  const hash = providerId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const hue = hash % 360;
  return theme === 'light' ? `hsl(${hue}, 55%, 40%)` : `hsl(${hue}, 55%, 55%)`;
}
