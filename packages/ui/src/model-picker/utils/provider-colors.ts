import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';

interface ProviderColorPair {
  readonly dark: string;
  readonly light: string;
}

/**
 * Every static registry provider has an explicit entry — pinned at COMPILE
 * time by the `satisfies Record<SupportedProvider, ...>` below (BST-1349,
 * PR #2513 review finding 6): adding a provider to the registry without a
 * color here is a type error. The hash fallback in `getProviderColor` is
 * reserved for dynamically discovered runtime ids.
 */
export const PROVIDER_COLOR_MAP: Record<string, ProviderColorPair> = {
  anthropic: { dark: 'hsl(25, 70%, 55%)', light: 'hsl(25, 70%, 45%)' },
  // AWS-orange family (#FF9900 ≈ 36°); saturation pushed well above
  // anthropic's 25°/70% so the two orange dots stay distinguishable at
  // swatch size.
  bedrock: { dark: 'hsl(36, 95%, 55%)', light: 'hsl(36, 95%, 38%)' },
  cohere: { dark: 'hsl(340, 60%, 55%)', light: 'hsl(340, 60%, 45%)' },
  google: { dark: 'hsl(210, 70%, 55%)', light: 'hsl(210, 70%, 45%)' },
  // 235° indigo: 45° from openrouter's 280° so the picker dots stay
  // distinguishable at swatch size (PR #2513 review, finding 10).
  lmstudio: { dark: 'hsl(235, 60%, 62%)', light: 'hsl(235, 60%, 45%)' },
  local: { dark: 'hsl(45, 70%, 55%)', light: 'hsl(45, 70%, 35%)' },
  // A real green hue — a desaturated gray reads as "disabled" in the picker
  // (PR #2513 review, finding 10).
  ollama: { dark: 'hsl(120, 45%, 55%)', light: 'hsl(120, 45%, 35%)' },
  openai: { dark: 'hsl(160, 60%, 50%)', light: 'hsl(160, 60%, 35%)' },
  // Deliberate KINSHIP with openai's 160° — this is the same vendor reached
  // through a ChatGPT subscription, so a related hue is the honest signal.
  // Separation comes from saturation + lightness rather than hue, exactly the
  // bedrock(36°/95%) vs anthropic(25°/70%) precedent above.
  'openai-codex': { dark: 'hsl(170, 95%, 62%)', light: 'hsl(170, 95%, 28%)' },
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
