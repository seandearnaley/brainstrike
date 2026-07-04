#!/usr/bin/env node

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildDbUnitLaneMap } from './db-test-lane-manifest.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsRoot = path.join(packageRoot, '__tests__');

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
    if (
      /\.test\.(ts|tsx)$/.test(relativePath) &&
      !/\.browser\.test\.(ts|tsx)$/.test(relativePath)
    ) {
      tests.push(relativePath);
    }
  }
  return tests;
}

function getLaneMap() {
  return buildDbUnitLaneMap(collectTests());
}

function validateLanes() {
  const { failures, laneMap } = getLaneMap();
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
