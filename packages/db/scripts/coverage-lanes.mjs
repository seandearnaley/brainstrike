#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsRoot = path.join(packageRoot, '__tests__');

const lanes = {
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
    // Subdirectory test (distinct from the top-level file-record-repository.test.ts);
    // referenced by its path relative to __tests__ now that collectUnitTests recurses.
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

// Recurses into subdirectories (mirroring test-lanes.mjs `collectTests`) and returns
// paths RELATIVE to __tests__ (POSIX-style `/`). A non-recursive readdir would let a
// test under a subdirectory (e.g. repositories/drizzle/file-record-repository.test.ts)
// silently escape BOTH this orphan check and every coverage lane. Relative paths also
// avoid a basename collision: the top-level file-record-repository.test.ts and the
// subdir one are distinct keys, so each must be assigned to a lane independently.
function collectUnitTests(dir = testsRoot, prefix = '') {
  const tests = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      tests.push(...collectUnitTests(path.join(dir, entry.name), relativePath));
      continue;
    }
    if (
      (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) &&
      !(entry.name.endsWith('.browser.test.ts') || entry.name.endsWith('.browser.test.tsx'))
    ) {
      tests.push(relativePath);
    }
  }
  return tests.sort();
}

function validateLanes() {
  const knownTests = new Set(collectUnitTests());
  const assigned = new Map();
  const failures = [];

  for (const [lane, files] of Object.entries(lanes)) {
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

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure);
    }
    return false;
  }
  return true;
}

function runLane(lane) {
  if (!validateLanes()) {
    return 1;
  }
  const files = lanes[lane];
  if (!files) {
    console.error(`Unknown DB coverage lane: ${lane}`);
    console.error(`Known lanes: ${Object.keys(lanes).join(', ')}`);
    return 1;
  }

  const result = spawnSync(
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      '--project',
      'unit',
      ...files.map((fileName) => path.join('__tests__', fileName)),
      '--coverage',
      '--coverage.reporter=json',
      `--coverage.reportsDirectory=coverage-db-${lane}`,
    ],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        COVERAGE: 'true',
        NODE_ENV: process.env.NODE_ENV ?? 'test',
      },
      shell: process.platform === 'win32',
      stdio: 'inherit',
    }
  );

  return result.status ?? 1;
}

function printLanes() {
  for (const [lane, files] of Object.entries(lanes)) {
    console.log(`${lane}: ${files.length}`);
  }
}

function main(args) {
  const [command, lane] = args;
  if (command === 'check') {
    const ok = validateLanes();
    if (ok) {
      printLanes();
    }
    return ok ? 0 : 1;
  }
  if (command === 'run' && lane) {
    return runLane(lane);
  }
  console.error('Usage: node scripts/coverage-lanes.mjs check|run <lane>');
  return 1;
}

process.exitCode = main(process.argv.slice(2));
