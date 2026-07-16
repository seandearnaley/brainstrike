#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDbCoverageLaneMap, collectDbTestFiles } from './db-test-lane-manifest.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function validateLanes() {
  // includeBrowserTests: false — coverage lanes run `vitest --project unit`, which cannot
  // execute browser-project files. test-lanes.mjs deliberately passes true; the asymmetry
  // is intentional and documented on collectDbTestFiles.
  const { failures, laneMap } = buildDbCoverageLaneMap(
    collectDbTestFiles({ includeBrowserTests: false })
  );

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
