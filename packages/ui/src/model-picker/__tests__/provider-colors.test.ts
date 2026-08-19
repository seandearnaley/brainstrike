import { describe, expect, it } from 'vitest';
import { getProviderColor, PROVIDER_COLOR_MAP } from '../utils/provider-colors';

/**
 * Registry exhaustiveness is a COMPILE-TIME pin now (`satisfies
 * Record<SupportedProvider, ...>` in provider-colors.ts, PR #2513 review
 * finding 6). This runtime test covers only what `satisfies` cannot: the
 * lookup/fallback behavior of getProviderColor itself.
 */
describe('provider colors', () => {
  it('returns the explicit map entry for mapped providers', () => {
    for (const [providerId, entry] of Object.entries(PROVIDER_COLOR_MAP)) {
      expect(getProviderColor(providerId, 'light')).toBe(entry.light);
      expect(getProviderColor(providerId, 'dark')).toBe(entry.dark);
    }
  });

  it('keeps the hash fallback for dynamically discovered ids only', () => {
    const fallback = getProviderColor('some-unknown-runtime', 'light');
    expect(fallback).toMatch(/^hsl\(/);
    expect(PROVIDER_COLOR_MAP['some-unknown-runtime']).toBeUndefined();
  });
});
