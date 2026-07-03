export const dbUnitLaneDefinitions = [
  {
    name: 'schema-migration',
    matches: [
      /^architecture-/,
      /^bootstrap-capability-probe\.test\.ts$/,
      /^brainstrike-db-client-contract\.test\.ts$/,
      /^bootstrap\.test\.ts$/,
      /^db-migration-authority\.test\.ts$/,
      /^db-runtime-baseline\.test\.ts$/,
      /^db-runtime-selection\.test\.ts$/,
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
  },
  {
    name: 'repository',
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
      /^turso-managed-cache-batch\.test\.ts$/,
      /^turso-token-cache-store\.test\.ts$/,
    ],
  },
  {
    name: 'queue',
    matches: [
      /^batch-insert\.test\.ts$/,
      /^bulk-import\.test\.ts$/,
      /^drizzle-job-queue-compatibility\.test\.ts$/,
      /^file-import-embedding-set\.test\.ts$/,
      /^idempotent-insert\.test\.ts$/,
      /^job-queue/,
      /^queue-cli\.test\.ts$/,
    ],
  },
  {
    name: 'search',
    matches: [
      /^hnsw-search-tuning\.integration\.test\.ts$/,
      /^hybrid-search-service\.test\.ts$/,
      /^retrieval-eval-runner\.test\.ts$/,
      /^retrieval-harness\.test\.ts$/,
      /^rrf\.test\.ts$/,
      /^search-/,
      /^tsvector-generated-column\.integration\.test\.ts$/,
      /^turso-capability-spike\.test\.ts$/,
      /^turso-owner-client\.test\.ts$/,
      /^turso-profile-bootstrap\.test\.ts$/,
      /^turso-schema-baseline\.test\.ts$/,
      /^uuidv7-primary-keys\.integration\.test\.ts$/,
      /^vector-extension\.integration\.test\.ts$/,
    ],
  },
  {
    name: 'integration',
    matches: [
      /^active-collection-live-counts\.test\.ts$/,
      /^atomic-transaction\.integration\.test\.ts$/,
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
      /^wasm-loader/,
    ],
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
      'architecture-profile-bootstrap-report.test.ts',
      'architecture-turso-live-query-guardrails.test.ts',
      'brainstrike-db-client-contract.test.ts',
      'db-runtime-selection.test.ts',
      'runtime-import-extensions.test.ts',
    ],
    chunking: [
      'active-collection-live-counts.test.ts',
      'collection-indexing-stats.test.ts',
      'file-import-embedding-set.test.ts',
      'managed-cache-batch.test.ts',
      'scheduled-database-maintenance.test.ts',
      'turso-managed-cache-batch.test.ts',
      'validate-embedding-batch.test.ts',
    ],
    repositories: ['atomic-transaction.integration.test.ts'],
    runtime: [
      'wasm-loader-coverage.test.ts',
      'wasm-loader-worker.test.ts',
      'wasm-loader.test.ts',
    ],
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
  const laneNames =
    laneOrder ??
    [
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
