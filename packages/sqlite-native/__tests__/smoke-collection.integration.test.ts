import { createRequire } from 'node:module';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
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

// A host budget, not a product latency contract (BST-2155). The round trip
// writes to a file database in os.tmpdir(), and each durable commit waits for a
// flush whose latency varies by VM; on Windows the mapped-module probe also
// starts PowerShell (about 0.4 s). Usually about 0.6 s on hosted Windows; one
// run took 6.7 s. 15 s, doubled under CI.
const HOST_BUDGET = { timeout: getAdjustedTimeout('integration') } as const;

describe('native smoke observes the running library', HOST_BUDGET, () => {
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
