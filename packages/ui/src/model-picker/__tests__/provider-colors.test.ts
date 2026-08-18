import { listProviders } from '@brainstrike/assistant-contract/provider-metadata';
import { describe, expect, it } from 'vitest';
import { getProviderColor, PROVIDER_COLOR_MAP } from '../utils/provider-colors';

describe('provider colors', () => {
  it('has an explicit entry for every registry provider (no hash fallback)', () => {
    for (const provider of listProviders()) {
      const entry = PROVIDER_COLOR_MAP[provider.id];
      expect(entry, `${provider.id} must not fall through to the hash fallback`).toBeDefined();
      expect(getProviderColor(provider.id, 'light')).toBe(entry?.light);
      expect(getProviderColor(provider.id, 'dark')).toBe(entry?.dark);
    }
  });

  it('keeps the hash fallback for dynamically discovered ids only', () => {
    const fallback = getProviderColor('some-unknown-runtime', 'light');
    expect(fallback).toMatch(/^hsl\(/);
    expect(PROVIDER_COLOR_MAP['some-unknown-runtime']).toBeUndefined();
  });
});
