import { describe, expect, it } from 'vitest';
import { buildInaccessibleContent, INACCESSIBLE_CONTENT_PREFIX } from '../inaccessible-content';

describe('inaccessible-content sentinel', () => {
  it('exposes the canonical English-prose prefix', () => {
    // Pin the literal string. Several consumers (workspace-tab-host,
    // use-persistent-token-cache, app-shell/workspace-collection-sync-service) match
    // on it via startsWith. If we ever rename, this test fails first to remind us to
    // update every consumer or graduate the contract to a typed status.
    expect(INACCESSIBLE_CONTENT_PREFIX).toBe('File not accessible');
  });

  it('buildInaccessibleContent always starts with the prefix', () => {
    expect(buildInaccessibleContent('permission required: src/index.ts')).toMatch(
      new RegExp(`^${INACCESSIBLE_CONTENT_PREFIX}`)
    );
    expect(buildInaccessibleContent('')).toBe(`${INACCESSIBLE_CONTENT_PREFIX} - `);
    expect(buildInaccessibleContent('Folder mismatch. Expected: a, Found: b')).toBe(
      `${INACCESSIBLE_CONTENT_PREFIX} - Folder mismatch. Expected: a, Found: b`
    );
  });
});
