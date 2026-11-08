// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  getProviderColor,
  PROVIDER_COLOR_MAP,
  UNKNOWN_PROVIDER_COLOR,
} from '../utils/provider-colors';

/**
 * Registry exhaustiveness is a COMPILE-TIME pin now (`satisfies
 * Record<SupportedProvider, ...>` in provider-colors.ts, PR #2513 review
 * finding 6). This runtime test covers only what `satisfies` cannot: the
 * lookup behavior of getProviderColor itself.
 */
describe('provider colors', () => {
  it('returns the explicit map entry for mapped providers', () => {
    for (const [providerId, entry] of Object.entries(PROVIDER_COLOR_MAP)) {
      expect(getProviderColor(providerId, 'light')).toBe(entry.light);
      expect(getProviderColor(providerId, 'dark')).toBe(entry.dark);
    }
  });

  it('gives an unmapped id the muted text colour in both themes, never a derived hue', () => {
    expect(getProviderColor('some-unknown-runtime', 'light')).toBe(UNKNOWN_PROVIDER_COLOR);
    expect(getProviderColor('another-runtime', 'dark')).toBe(UNKNOWN_PROVIDER_COLOR);
  });
});
