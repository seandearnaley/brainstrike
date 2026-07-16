import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Absolute path to packages/db/__tests__, resolved from this module, not the caller's cwd. */
export const dbTestsRoot = path.join(packageRoot, '__tests__');

const TEST_FILE_PATTERN = /\.test\.(ts|tsx)$/;
const BROWSER_TEST_FILE_PATTERN = /\.browser\.test\.(ts|tsx)$/;

export const dbUnitLaneDefinitions = [
  {
    matches: [
      /^architecture-/,
      /^brainstrike-db-client-contract\.test\.ts$/,
      /^bootstrap\.test\.ts$/,
      /^db-migration-authority\.test\.ts$/,
      /^db-runtime-baseline\.test\.ts$/,
      /^db-test-lane-manifest\.test\.ts$/,
      /^dimension-index-maintenance\.test\.ts$/,
      /^dimension-hnsw-indexes\.integration\.test\.ts$/,
      /^frontier-models-migration\.test\.ts$/,
      /^drizzle-database(\.integration)?\.test\.ts$/,
      /^drizzle-migrate\.test\.ts$/,
      /^drizzle-pglite-spike\.test\.ts$/,
      /^gemma-local-llm-migration\.test\.ts$/,
      /^mastra-om-schema-projection\.test\.ts$/,
      /^migration-/,
      /^migration-integration\.test\.ts$/,
      /^pglite-engine-major\.integration\.test\.ts$/,
      /^provider-catalog-timestamps-migration\.test\.ts$/,
      /^runtime-import-extensions\.test\.ts$/,
      /^view-filter-presets-migration\.test\.ts$/,
    ],
    name: 'schema-migration',
  },
  {
    matches: [
      /repository\.test\.ts$/,
      /repositories\//,
      /^chunk-embedding-metadata\.test\.ts$/,
      /^drizzle-embedding-sets-repository\.test\.ts$/,
      /^drizzle-token-cache-store\.test\.ts$/,
      /^drizzle-view-filter-presets-repository\.test\.ts$/,
      /^electron-view-filter-presets-repository\.test\.ts$/,
      /^embedding-sets-repository\.test\.ts$/,
      /^file-record-model\.test\.ts$/,
      /^managed-cache-batch\.test\.ts$/,
      /^repository-/,
    ],
    name: 'repository',
  },
  {
    matches: [
      /^batch-insert\.test\.ts$/,
      /^bulk-import\.test\.ts$/,
      /^drizzle-job-queue-compatibility\.test\.ts$/,
      /^file-import-embedding-set\.test\.ts$/,
      /^idempotent-insert\.test\.ts$/,
      /^job-queue/,
      /^queue-cli\.test\.ts$/,
    ],
    name: 'queue',
  },
  {
    matches: [
      /^hnsw-search-tuning\.integration\.test\.ts$/,
      /^hybrid-search-service\.test\.ts$/,
      /^retrieval-eval-runner\.test\.ts$/,
      /^retrieval-harness\.test\.ts$/,
      /^rrf\.test\.ts$/,
      /^search-/,
      /^tsvector-generated-column\.integration\.test\.ts$/,
      /^uuidv7-primary-keys\.integration\.test\.ts$/,
      /^vector-extension\.integration\.test\.ts$/,
      /^workspace-search-scoping\.test\.ts$/,
    ],
    name: 'search',
  },
  {
    matches: [
      /^active-collection-live-counts\.test\.ts$/,
      /^atomic-transaction\.integration\.test\.ts$/,
      /^browser-first-run-bootstrap/,
      /^browser-pglite-storage/,
      /^chunking-config\.test\.ts$/,
      /^clear-data\.test\.tsx$/,
      /^collection-indexing-stats\.test\.ts$/,
      /^database-pressure-controller\.test\.ts$/,
      /^database-work-scheduler\.test\.ts$/,
      /^db-provider/,
      /^factory-reset\.test\.tsx$/,
      /^foreground-responsiveness-smoke\.test\.ts$/,
      /^index\.test\.ts$/,
      /^json-import-attributes\.test\.ts$/,
      /^pglite-browser\.browser\.test\.ts$/,
      /^scheduled-database-maintenance\.test\.ts$/,
      /^shared-helpers\.test\.ts$/,
      /^use-/,
      /^validate-embedding-batch\.test\.ts$/,
      /^vitest-mutation-config-contract\.test\.ts$/,
      /^wasm-loader/,
    ],
    name: 'integration',
  },
];

export const dbCoverageLaneDefinitions = {
  coverageDefaultsByUnitLane: {
    integration: 'architecture',
    queue: 'queue',
    repository: 'repositories',
    'schema-migration': 'migrations',
    search: 'search',
  },
  coverageOverridesByLane: {
    architecture: [
      'architecture-boundary.test.ts',
      'architecture-ownership.test.ts',
      'brainstrike-db-client-contract.test.ts',
      'db-test-lane-manifest.test.ts',
      'runtime-import-extensions.test.ts',
    ],
    chunking: [
      'active-collection-live-counts.test.ts',
      'collection-indexing-stats.test.ts',
      'file-import-embedding-set.test.ts',
      'managed-cache-batch.test.ts',
      'scheduled-database-maintenance.test.ts',
      'validate-embedding-batch.test.ts',
    ],
    repositories: ['atomic-transaction.integration.test.ts'],
    runtime: ['wasm-loader-coverage.test.ts', 'wasm-loader-worker.test.ts', 'wasm-loader.test.ts'],
  },
  laneOrder: [
    'architecture',
    'chunking',
    'migrations',
    'queue',
    'repositories',
    'search',
    'runtime',
  ],
  unitLaneDefinitions: dbUnitLaneDefinitions,
};

/**
 * Collects DB test files under `packages/db/__tests__`, returning paths RELATIVE to that
 * directory (POSIX-style `/`), sorted. This is the single collector shared by BOTH lane
 * scripts and the manifest's guard test — do not hand-roll a second copy, or the two
 * views of "all tests" can drift apart (the issue-#1101 class of bug, in miniature).
 *
 * `includeBrowserTests` is the ONE intentional difference between the two lane scripts'
 * views, and it is structurally necessary. DO NOT collapse it:
 *
 * - `test-lanes.mjs` passes `true`. Unit lanes must account for EVERY test file in the
 *   directory — browser-project ones included — so that no file silently escapes lane
 *   assignment. It runs each lane's files through `vitest run --project unit`, but its
 *   `check` command's job is total coverage of the directory.
 * - `coverage-lanes.mjs` passes `false`. Coverage lanes also run `vitest run --project
 *   unit`, which CANNOT execute browser-project files (`*.browser.test.ts` / `.tsx` run
 *   under the separate `browser` project). Including them would hand the unit project
 *   tests it physically cannot run.
 *
 * Net effect: the unit view is a strict superset of the coverage view, differing by
 * exactly the `*.browser.test.*` files. `db-test-lane-manifest.test.ts` pins that.
 *
 * Recursion matters: a non-recursive readdir would let a test in a subdirectory (e.g.
 * `repositories/drizzle/file-record-repository.test.ts`) silently escape every lane.
 * Relative — not base — names also avoid a collision: a top-level
 * `file-record-repository.test.ts` and the subdirectory one are distinct keys and must
 * each be assigned to a lane independently.
 *
 * @param {{ includeBrowserTests: boolean, testsRoot?: string }} options
 * @returns {string[]}
 */
export function collectDbTestFiles(options) {
  const { includeBrowserTests, testsRoot = dbTestsRoot } = options ?? {};
  if (typeof includeBrowserTests !== 'boolean') {
    // No silent default: an implicit choice here is exactly how the two views drift.
    throw new TypeError(
      'collectDbTestFiles requires an explicit { includeBrowserTests: boolean } — pass true for unit lanes, false for coverage lanes.'
    );
  }

  const collect = (dir, prefix) => {
    const tests = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        tests.push(...collect(path.join(dir, entry.name), relativePath));
        continue;
      }
      if (!TEST_FILE_PATTERN.test(entry.name)) {
        continue;
      }
      if (!includeBrowserTests && BROWSER_TEST_FILE_PATTERN.test(entry.name)) {
        continue;
      }
      tests.push(relativePath);
    }
    return tests;
  };

  return collect(testsRoot, '').sort();
}

export function buildDbUnitLaneMap(testFiles, laneDefinitions = dbUnitLaneDefinitions) {
  const laneMap = new Map(laneDefinitions.map((lane) => [lane.name, []]));
  const failures = [];

  for (const testFile of testFiles) {
    const matchedLanes = laneDefinitions.filter((lane) =>
      lane.matches.some((pattern) => pattern.test(testFile))
    );
    if (matchedLanes.length !== 1) {
      failures.push(
        `${testFile} matched ${matchedLanes.length} DB test lanes: ${matchedLanes
          .map((lane) => lane.name)
          .join(', ')}`
      );
      continue;
    }
    laneMap.get(matchedLanes[0].name)?.push(testFile);
  }

  for (const [lane, files] of laneMap.entries()) {
    if (files.length === 0) {
      failures.push(`DB test lane ${lane} has no tests.`);
    }
  }

  return { failures, laneMap };
}

function buildCoverageOverrideMap(coverageOverridesByLane, knownTests) {
  const assigned = new Map();
  const failures = [];

  for (const [lane, files] of Object.entries(coverageOverridesByLane)) {
    if (!Array.isArray(files)) {
      failures.push(`Coverage lane override ${lane} must be an array of test files.`);
      continue;
    }
    for (const fileName of files) {
      if (!knownTests.has(fileName)) {
        failures.push(`Lane ${lane} references missing test ${fileName}.`);
      }
      const existingLane = assigned.get(fileName);
      if (existingLane) {
        failures.push(`Test ${fileName} is assigned to both ${existingLane} and ${lane}.`);
      }
      assigned.set(fileName, lane);
    }
  }

  return { failures, overrideMap: assigned };
}

export function buildDbCoverageLaneMap(testFiles, laneDefinitions = dbCoverageLaneDefinitions) {
  const knownTests = new Set(testFiles);
  const {
    coverageDefaultsByUnitLane,
    coverageOverridesByLane = {},
    laneOrder,
    unitLaneDefinitions,
  } = laneDefinitions;
  const unitLaneResult = buildDbUnitLaneMap(testFiles, unitLaneDefinitions);
  const failures = [...unitLaneResult.failures];
  const { failures: overrideFailures, overrideMap } = buildCoverageOverrideMap(
    coverageOverridesByLane,
    knownTests
  );
  failures.push(...overrideFailures);
  const laneNames = laneOrder ?? [
    ...new Set([
      ...Object.values(coverageDefaultsByUnitLane ?? {}),
      ...Object.keys(coverageOverridesByLane),
    ]),
  ];
  const laneMap = new Map(laneNames.map((lane) => [lane, []]));
  const unitLaneByTest = new Map();

  for (const [unitLane, coverageLane] of Object.entries(coverageDefaultsByUnitLane ?? {})) {
    if (!laneMap.has(coverageLane)) {
      failures.push(
        `Coverage default for DB unit lane ${unitLane} references unknown coverage lane ${coverageLane}.`
      );
    }
  }

  for (const coverageLane of Object.keys(coverageOverridesByLane)) {
    if (!laneMap.has(coverageLane)) {
      failures.push(`Coverage override references unknown coverage lane ${coverageLane}.`);
    }
  }

  for (const [unitLane, files] of unitLaneResult.laneMap.entries()) {
    for (const fileName of files) {
      unitLaneByTest.set(fileName, unitLane);
    }
  }

  for (const fileName of knownTests) {
    const unitLane = unitLaneByTest.get(fileName);
    if (!unitLane) {
      continue;
    }
    const coverageLane = overrideMap.get(fileName) ?? coverageDefaultsByUnitLane?.[unitLane];
    if (!coverageLane) {
      failures.push(`Test ${fileName} has no coverage default for DB unit lane ${unitLane}.`);
      continue;
    }
    if (!laneMap.has(coverageLane)) {
      failures.push(`Test ${fileName} maps to unknown coverage lane ${coverageLane}.`);
      continue;
    }
    laneMap.get(coverageLane)?.push(fileName);
  }

  for (const [lane, files] of laneMap.entries()) {
    if (files.length === 0) {
      failures.push(`Lane ${lane} has no tests.`);
    }
  }

  return { failures, laneMap };
}
