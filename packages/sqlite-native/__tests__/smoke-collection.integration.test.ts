import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

interface Facts {
  extensionPath: string;
  mappedNativeFiles: string[];
  nearestId: number;
  platform: string;
  requireCacheNodes: string[];
  vecVersion: string;
}
interface Smoke {
  collectFacts: (requireFrom: NodeJS.Require) => Facts;
  provenanceFailures: (facts: Facts, options: { packaged: boolean }) => string[];
}
const requireFrom = createRequire(import.meta.url);
const { collectFacts, provenanceFailures } = requireFrom('../test/smoke-lib.cjs') as Smoke;

describe('native smoke observes the running library', () => {
  it('proves the actual prebuild, mapped extension and vector round trip, and rejects corrupted observations', () => {
    const facts = collectFacts(requireFrom);
    expect(facts.nearestId).toBe(1);
    expect(facts.vecVersion).toMatch(/^v\d+\.\d+\.\d+/);
    expect(provenanceFailures(facts, { packaged: false })).toEqual([]);
    for (const changed of [
      { vecVersion: 'invalid' },
      { nearestId: 2 },
      { requireCacheNodes: [] },
      { requireCacheNodes: ['/tmp/unreviewed.node'] },
      { extensionPath: '/tmp/unreviewed.dylib' },
      { mappedNativeFiles: [] },
      { mappedNativeFiles: [...facts.mappedNativeFiles, '/tmp/extra-better-sqlite3.node'] },
    ]) {
      expect(
        provenanceFailures({ ...facts, ...changed }, { packaged: false }).length
      ).toBeGreaterThan(0);
    }
  });
});
