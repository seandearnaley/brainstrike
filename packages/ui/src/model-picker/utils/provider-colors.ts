export const PROVIDER_COLOR_MAP: Record<string, { light: string; dark: string }> = {
  openai: { light: 'hsl(160, 60%, 35%)', dark: 'hsl(160, 60%, 50%)' },
  anthropic: { light: 'hsl(25, 70%, 45%)', dark: 'hsl(25, 70%, 55%)' },
  google: { light: 'hsl(210, 70%, 45%)', dark: 'hsl(210, 70%, 55%)' },
  openrouter: { light: 'hsl(280, 60%, 45%)', dark: 'hsl(280, 60%, 55%)' },
  cohere: { light: 'hsl(340, 60%, 45%)', dark: 'hsl(340, 60%, 55%)' },
  voyage: { light: 'hsl(180, 60%, 35%)', dark: 'hsl(180, 60%, 50%)' },
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
