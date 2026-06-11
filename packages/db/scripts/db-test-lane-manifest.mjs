export const dbUnitLaneDefinitions = [
  {
    name: 'schema-migration',
    matches: [
      /^architecture-/,
      /^brainstrike-db-client-contract\.test\.ts$/,
      /^bootstrap\.test\.ts$/,
      /^db-migration-authority\.test\.ts$/,
      /^db-runtime-baseline\.test\.ts$/,
      /^dimension-hnsw-indexes\.integration\.test\.ts$/,
      /^frontier-models-migration\.test\.ts$/,
      /^drizzle-database(\.integration)?\.test\.ts$/,
      /^drizzle-migrate\.test\.ts$/,
      /^drizzle-pglite-spike\.test\.ts$/,
      /^gemma-local-llm-migration\.test\.ts$/,
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
  architecture: [
    'brainstrike-db-client-contract.test.ts',
    'browser-pglite-storage-benchmark.test.ts',
    'browser-pglite-storage.test.ts',
    'architecture-boundary.test.ts',
    'architecture-ownership.test.ts',
    'chunking-config.test.ts',
    'database-pressure-controller.test.ts',
    'database-work-scheduler.test.ts',
    'clear-data.test.tsx',
    'db-provider-default-path.test.tsx',
    'db-provider-error-handling.test.tsx',
    'db-provider-init-sql-contract.test.tsx',
    'db-provider-initializing.test.tsx',
    'db-provider-lifecycle.test.tsx',
    'db-provider-migration.test.tsx',
    'db-provider-paths.test.ts',
    'db-provider.test.tsx',
    'factory-reset.test.tsx',
    'foreground-responsiveness-smoke.test.ts',
    'index.test.ts',
    'json-import-attributes.test.ts',
    'runtime-import-extensions.test.ts',
    'shared-helpers.test.ts',
    'use-drizzle-live-query.test.ts',
    'use-drizzle-live-query.test.tsx',
    'use-live-query.test.tsx',
  ],
  chunking: [
    'active-collection-live-counts.test.ts',
    'collection-indexing-stats.test.ts',
    'file-import-embedding-set.test.ts',
    'managed-cache-batch.test.ts',
    'scheduled-database-maintenance.test.ts',
    'validate-embedding-batch.test.ts',
  ],
  migrations: [
    'bootstrap.test.ts',
    'db-migration-authority.test.ts',
    'db-runtime-baseline.test.ts',
    'dimension-hnsw-indexes.integration.test.ts',
    'drizzle-database.integration.test.ts',
    'drizzle-database.test.ts',
    'drizzle-migrate.test.ts',
    'drizzle-pglite-spike.test.ts',
    'frontier-models-migration.test.ts',
    'gemma-local-llm-migration.test.ts',
    'migration-authority-guard.test.ts',
    'migration-integration.test.ts',
    'migration-runner-types.test.ts',
    'migration-runner.test.ts',
    'pglite-engine-major.integration.test.ts',
    'provider-catalog-timestamps-migration.test.ts',
    'view-filter-presets-migration.test.ts',
  ],
  queue: [
    'batch-insert.test.ts',
    'bulk-import.test.ts',
    'drizzle-job-queue-compatibility.test.ts',
    'idempotent-insert.test.ts',
    'job-queue-admin.test.ts',
    'job-queue-batch.test.ts',
    'job-queue-concurrency.test.ts',
    'job-queue-dedup-upsert.test.ts',
    'job-queue-expired-lease.test.ts',
    'job-queue-heartbeat.test.ts',
    'job-queue-id-type.test.ts',
    'job-queue-race.test.ts',
    'job-queue-stats.test.ts',
    'job-queue-telemetry.test.ts',
    'job-queue-transactional-enqueue.test.ts',
    'job-queue.test.ts',
    'queue-cli.test.ts',
  ],
  repositories: [
    'atomic-transaction.integration.test.ts',
    'chunk-embedding-metadata.test.ts',
    'drizzle-embedding-cache-repository.test.ts',
    'drizzle-embedding-sets-repository.test.ts',
    'drizzle-file-chunk-repository.test.ts',
    'drizzle-file-record-repository.test.ts',
    'drizzle-token-cache-store.test.ts',
    'drizzle-view-filter-presets-repository.test.ts',
    'electron-file-chunk-repository.test.ts',
    'electron-file-record-repository.test.ts',
    'electron-view-filter-presets-repository.test.ts',
    'embedding-cache-repository.test.ts',
    'embedding-sets-repository.test.ts',
    'file-chunk-repository.test.ts',
    'file-record-model.test.ts',
    'file-record-repository.test.ts',
    // Subdirectory test: distinct from the top-level file-record-repository.test.ts.
    'repositories/drizzle/file-record-repository.test.ts',
    'repository-clear.test.ts',
    'repository-factory.test.ts',
  ],
  search: [
    'hnsw-search-tuning.integration.test.ts',
    'hybrid-search-service.test.ts',
    'retrieval-eval-runner.test.ts',
    'retrieval-harness.test.ts',
    'rrf.test.ts',
    'search-grep-pattern.test.ts',
    'search-grep-service.test.ts',
    'search-grep.integration.test.ts',
    'search-similar-sql-path.integration.test.ts',
    'search-similar-sql-path.test.ts',
    'search-similar.behavior.test.ts',
    'tsvector-generated-column.integration.test.ts',
    'uuidv7-primary-keys.integration.test.ts',
    'vector-extension.integration.test.ts',
  ],
  runtime: [
    'wasm-loader-coverage.test.ts',
    'wasm-loader-worker.test.ts',
    'wasm-loader.test.ts',
  ],
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

export function buildDbCoverageLaneMap(testFiles, laneDefinitions = dbCoverageLaneDefinitions) {
  const knownTests = new Set(testFiles);
  const assigned = new Map();
  const failures = [];
  const laneMap = new Map(Object.entries(laneDefinitions).map(([lane, files]) => [lane, [...files]]));

  for (const [lane, files] of laneMap.entries()) {
    if (files.length === 0) {
      failures.push(`Lane ${lane} has no tests.`);
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

  for (const fileName of knownTests) {
    if (!assigned.has(fileName)) {
      failures.push(`Test ${fileName} is not assigned to a coverage lane.`);
    }
  }

  return { failures, laneMap };
}
