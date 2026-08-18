/**
 * Every static registry provider has an explicit entry (pinned by
 * provider-colors.test.ts against `listProviders()`, BST-1349). The hash
 * fallback below is reserved for dynamically discovered runtime ids.
 */
export const PROVIDER_COLOR_MAP: Record<string, { light: string; dark: string }> = {
  anthropic: { dark: 'hsl(25, 70%, 55%)', light: 'hsl(25, 70%, 45%)' },
  cohere: { dark: 'hsl(340, 60%, 55%)', light: 'hsl(340, 60%, 45%)' },
  google: { dark: 'hsl(210, 70%, 55%)', light: 'hsl(210, 70%, 45%)' },
  lmstudio: { dark: 'hsl(255, 55%, 60%)', light: 'hsl(255, 55%, 45%)' },
  local: { dark: 'hsl(45, 70%, 55%)', light: 'hsl(45, 70%, 35%)' },
  ollama: { dark: 'hsl(0, 0%, 60%)', light: 'hsl(0, 0%, 40%)' },
  openai: { dark: 'hsl(160, 60%, 50%)', light: 'hsl(160, 60%, 35%)' },
  openrouter: { dark: 'hsl(280, 60%, 55%)', light: 'hsl(280, 60%, 45%)' },
  voyage: { dark: 'hsl(180, 60%, 50%)', light: 'hsl(180, 60%, 35%)' },
};

export function getProviderColor(providerId: string, theme: 'light' | 'dark'): string {
  if (PROVIDER_COLOR_MAP[providerId]) {
    return PROVIDER_COLOR_MAP[providerId][theme];
  }
  // Fallback: hash-based color
  const hash = providerId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const hue = hash % 360;
  return theme === 'light' ? `hsl(${hue}, 55%, 40%)` : `hsl(${hue}, 55%, 55%)`;
}
