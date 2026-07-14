import { describe, expect, it } from 'vitest';
import {
  buildDbCoverageLaneMap,
  collectDbTestFiles,
  dbCoverageLaneDefinitions,
  dbUnitLaneDefinitions,
} from '../scripts/db-test-lane-manifest.mjs';

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
    // this file itself), via the SAME collector coverage-lanes.mjs uses: a new test file
    // needs only a dbUnitLaneDefinitions regex to resolve a coverage lane automatically
    // — no second, independent registration.
    const testFiles = collectDbTestFiles({ includeBrowserTests: false });

    const { failures, laneMap } = buildDbCoverageLaneMap(testFiles);

    expect(failures).toEqual([]);

    const assignedFiles = [...laneMap.values()].flat().sort();
    expect(assignedFiles).toEqual(testFiles);
  });

  it('differs between the unit and coverage views by exactly the browser tests', () => {
    // Pins the ONE intentional asymmetry between the two lane scripts' views of "all
    // tests" (test-lanes.mjs passes true, coverage-lanes.mjs passes false). It is
    // structurally necessary — coverage runs `vitest --project unit`, which cannot
    // execute browser-project files.
    const unitView = collectDbTestFiles({ includeBrowserTests: true });
    const coverageView = collectDbTestFiles({ includeBrowserTests: false });
    const isBrowserTest = (fileName: string) => fileName.includes('.browser.test.');

    // BOTH directions must be pinned, or the flag is only half-guarded:
    //
    // 1. Presence — the unit view really does include browser tests. Without this, an
    //    unconditional `if (BROWSER_TEST_FILE_PATTERN.test(name)) continue;` (i.e. a
    //    future agent deleting the `!includeBrowserTests &&` as redundant-looking)
    //    satisfies the relative check below VACUOUSLY: both views lose browser tests
    //    together, their difference is still empty, and the unit lane silently drops a
    //    file with every check still exiting 0.
    //    If this ever fails because the last *.browser.test.* file was deleted, that is
    //    a real signal, not noise: with zero browser tests the two views are identical
    //    and `includeBrowserTests` has no live use case, so the flag itself should be
    //    revisited rather than this assertion loosened.
    expect(unitView.some(isBrowserTest)).toBe(true);

    // 2. Relative — the views differ by exactly the browser tests, nothing else. Stated
    //    as a set relation rather than a hardcoded filename so it survives browser tests
    //    being added or renamed.
    expect(unitView.filter((fileName) => !isBrowserTest(fileName))).toEqual(coverageView);
    // The unit view is a strict superset: every coverage file is also a unit file.
    expect(coverageView.every((fileName) => unitView.includes(fileName))).toBe(true);
  });

  it('requires an explicit includeBrowserTests rather than silently defaulting', () => {
    // NO SILENT FALLBACKS: an implicit default here is precisely how the unit and
    // coverage views would drift apart again.
    // @ts-expect-error — deliberately calling with the option omitted.
    expect(() => collectDbTestFiles()).toThrow(/explicit \{ includeBrowserTests: boolean \}/);
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
