import { describe, expect, it } from 'vitest';
import { createDelegatedDisplayIdentity } from '../../assistant-server/delegated-display-identity';

describe('delegated display identity', () => {
  it('keeps callsigns stable while spreading new children across names and colors', () => {
    const ids = Array.from({ length: 96 }, (_, index) => `child-${index}`);
    const identities = ids.map(createDelegatedDisplayIdentity);
    expect(createDelegatedDisplayIdentity(ids[0] ?? '')).toEqual(identities[0]);
    expect(
      new Set(identities.map(({ displayName }) => displayName.split('-')[0])).size
    ).toBeGreaterThan(35);
    expect(new Set(identities.map(({ color }) => color)).size).toBeGreaterThan(14);
    for (const identity of identities) {
      expect(identity.displayName).toMatch(/^[A-Z][a-z]+-[0-9a-f]{6}$/u);
    }
  });
});
