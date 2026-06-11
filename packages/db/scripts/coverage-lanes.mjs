#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDbCoverageLaneMap } from './db-test-lane-manifest.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsRoot = path.join(packageRoot, '__tests__');

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
  const { failures, laneMap } = buildDbCoverageLaneMap(collectUnitTests());

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure);
    }
    return null;
  }
  return laneMap;
}

function runLane(lane) {
  const laneMap = validateLanes();
  if (!laneMap) {
    return 1;
  }
  const files = laneMap.get(lane);
  if (!files) {
    console.error(`Unknown DB coverage lane: ${lane}`);
    console.error(`Known lanes: ${[...laneMap.keys()].join(', ')}`);
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

function printLanes(laneMap) {
  for (const [lane, files] of laneMap.entries()) {
    console.log(`${lane}: ${files.length}`);
  }
}

function main(args) {
  const [command, lane] = args;
  if (command === 'check') {
    const laneMap = validateLanes();
    if (laneMap) {
      printLanes(laneMap);
    }
    return laneMap ? 0 : 1;
  }
  if (command === 'run' && lane) {
    return runLane(lane);
  }
  console.error('Usage: node scripts/coverage-lanes.mjs check|run <lane>');
  return 1;
}

process.exitCode = main(process.argv.slice(2));
