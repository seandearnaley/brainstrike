import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildDbCoverageLaneMap,
  dbCoverageLaneDefinitions,
  dbUnitLaneDefinitions,
} from '../scripts/db-test-lane-manifest.mjs';

/**
 * Mirrors `collectUnitTests` in packages/db/scripts/coverage-lanes.mjs: same recursive
 * scan, same `.test.ts`/`.test.tsx` match, same `.browser.test.ts`/`.browser.test.tsx`
 * exclusion (browser-project tests run under a different vitest project and are out of
 * scope for coverage lanes). Duplicated here — rather than imported — because that
 * function is a script-local implementation detail, not part of the manifest's public
 * surface (`db-test-lane-manifest.mjs` only exports the lane definitions and the two
 * `build*LaneMap` functions).
 */
function collectUnitTestFileNames(dir: string, prefix = ''): string[] {
  const tests: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      tests.push(...collectUnitTestFileNames(path.join(dir, entry.name), relativePath));
      continue;
    }
    const isTestFile = entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx');
    const isBrowserTestFile =
      entry.name.endsWith('.browser.test.ts') || entry.name.endsWith('.browser.test.tsx');
    if (isTestFile && !isBrowserTestFile) {
      tests.push(relativePath);
    }
  }
  return tests.sort();
}

describe('db test lane manifest', () => {
  it('gives every DB unit lane a coverage default', () => {
    // Every name in dbUnitLaneDefinitions must have a corresponding entry in
    // coverageDefaultsByUnitLane. This is the one manual step left after the
    // Series C task 8 audit: adding a NEW unit lane (not just a new test in an
    // existing lane) still requires wiring its coverage default by hand. If this
    // assertion ever fails, buildDbCoverageLaneMap will also fail loudly at
    // `pnpm --filter @brainstrike/db test:coverage:db:check-lanes` — see the third
    // test below for proof that failure is loud, not silent.
    const unitLaneNames = dbUnitLaneDefinitions.map((lane) => lane.name);
    const { coverageDefaultsByUnitLane } = dbCoverageLaneDefinitions;
    const lanesMissingCoverageDefault = unitLaneNames.filter(
      (name) => !(name in coverageDefaultsByUnitLane)
    );

    expect(lanesMissingCoverageDefault).toEqual([]);
  });

  it('assigns every real packages/db/__tests__ file to exactly one coverage lane', () => {
    // Dogfoods the single-source flow against the REAL __tests__ directory (including
    // this file itself): a new test file needs only a dbUnitLaneDefinitions regex to
    // resolve a coverage lane automatically — no second, independent registration.
    const testFiles = collectUnitTestFileNames(import.meta.dirname);

    const { failures, laneMap } = buildDbCoverageLaneMap(testFiles);

    expect(failures).toEqual([]);

    const assignedFiles = [...laneMap.values()].flat().sort();
    expect(assignedFiles).toEqual(testFiles);
  });

  it('fails loudly (not silently) when a unit lane has no coverage default', () => {
    // Reproduces the one residual manual step: a brand-new unit lane with no
    // coverageDefaultsByUnitLane entry must not let its tests silently vanish from
    // coverage. buildDbCoverageLaneMap must surface an explicit failure instead.
    const orphanLaneDefinitions = {
      ...dbCoverageLaneDefinitions,
      unitLaneDefinitions: [{ matches: [/^orphan-lane-fixture\.test\.ts$/], name: 'orphan-lane' }],
      // 'orphan-lane' is intentionally absent from coverageDefaultsByUnitLane.
    };

    const { failures } = buildDbCoverageLaneMap(
      ['orphan-lane-fixture.test.ts'],
      orphanLaneDefinitions
    );

    expect(failures).toContain(
      'Test orphan-lane-fixture.test.ts has no coverage default for DB unit lane orphan-lane.'
    );
  });
});
