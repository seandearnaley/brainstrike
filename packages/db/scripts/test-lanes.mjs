#!/usr/bin/env node

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsRoot = path.join(packageRoot, '__tests__');

const laneDefinitions = [
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
      /^hybrid-search-service\.test\.ts$/,
      /^retrieval-eval-runner\.test\.ts$/,
      /^retrieval-harness\.test\.ts$/,
      /^rrf\.test\.ts$/,
      /^search-/,
      /^vector-extension\.integration\.test\.ts$/,
    ],
  },
  {
    name: 'integration',
    matches: [
      /^active-collection-live-counts\.test\.ts$/,
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

function collectTests(dir = testsRoot, prefix = '') {
  const entries = readdirSync(dir).sort();
  const tests = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const relativePath = prefix ? `${prefix}/${entry}` : entry;
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      tests.push(...collectTests(fullPath, relativePath));
      continue;
    }
    if (/\.(browser\.)?test\.(ts|tsx)$/.test(relativePath)) {
      tests.push(relativePath);
    }
  }
  return tests;
}

function getLaneMap() {
  const laneMap = new Map(laneDefinitions.map((lane) => [lane.name, []]));
  const failures = [];

  for (const testFile of collectTests()) {
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

  return { failures, laneMap };
}

function validateLanes() {
  const { failures, laneMap } = getLaneMap();
  for (const [lane, files] of laneMap.entries()) {
    if (files.length === 0) {
      failures.push(`DB test lane ${lane} has no tests.`);
    }
  }
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure);
    }
    return null;
  }
  return laneMap;
}

function printLanes(laneMap) {
  for (const [lane, files] of laneMap.entries()) {
    console.log(`${lane}: ${files.length}`);
  }
}

function runLane(laneName) {
  const laneMap = validateLanes();
  if (!laneMap) {
    return 1;
  }
  if (laneName === 'all') {
    for (const name of laneMap.keys()) {
      const exitCode = runLane(name);
      if (exitCode !== 0) {
        return exitCode;
      }
    }
    return 0;
  }
  const files = laneMap.get(laneName);
  if (!files) {
    console.error(`Unknown DB test lane: ${laneName}`);
    console.error(`Known lanes: ${[...laneMap.keys()].join(', ')}`);
    return 1;
  }

  const result = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'run', '--project', 'unit', ...files.map((file) => path.join('__tests__', file))],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV ?? 'test',
      },
      shell: process.platform === 'win32',
      stdio: 'inherit',
    }
  );
  return result.status ?? 1;
}

function main(args) {
  const [command, laneName] = args;
  if (command === 'check') {
    const laneMap = validateLanes();
    if (!laneMap) {
      return 1;
    }
    printLanes(laneMap);
    return 0;
  }
  if (command === 'run' && laneName) {
    return runLane(laneName);
  }
  console.error('Usage: node scripts/test-lanes.mjs check|run <lane|all>');
  return 1;
}

process.exitCode = main(process.argv.slice(2));
