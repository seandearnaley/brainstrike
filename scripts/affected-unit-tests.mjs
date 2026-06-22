#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createSpawnInvocation } from './spawn-command.mjs';

const DEFAULT_TOTAL_LANES = 4;
const DEFAULT_WORKSPACE_CONCURRENCY = 2;
const DEFAULT_TEST_WEIGHT_MS = 1000;
const DB_PACKAGE_NAME = '@brainstrike/db';
const DB_LANES = new Set(['repository', 'schema-migration', 'remaining']);
const PACKAGE_TEST_WEIGHTS_MS = new Map([
  ['@brainstrike/db', 395000],
  ['@brainstrike/desktop', 111000],
  ['@brainstrike/embeddings', 51000],
  ['@brainstrike/agent', 51000],
  ['@brainstrike/file-explorer-ui', 31000],
  ['@brainstrike/app-shell', 22000],
  ['@brainstrike/file-explorer', 9000],
  ['@brainstrike/ui', 9000],
  ['@brainstrike/web', 10000],
  ['@brainstrike/db-explorer', 9000],
  ['@brainstrike/preferences', 9000],
  ['@brainstrike/file-explorer-hooks', 6000],
  ['@brainstrike/vector-management', 7000],
  ['@brainstrike/utils', 5000],
  ['@brainstrike/file-import', 6000],
]);

export function parsePnpmListJson(output) {
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed)) {
    throw new Error('Expected pnpm list --json to return an array.');
  }
  return parsed
    .map((entry) => entry?.name)
    .filter((name) => typeof name === 'string' && name.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

export function filterTestablePackages(packageNames, manifestsByName) {
  return packageNames.filter((name) => {
    const manifest = manifestsByName.get(name);
    return typeof manifest?.scripts?.test === 'string' && manifest.scripts.test.length > 0;
  });
}

export function buildLanePackageNames(packageNames, lane, totalLanes) {
  if (!Number.isInteger(totalLanes) || totalLanes < 1) {
    throw new Error('total lanes must be a positive integer.');
  }
  if (!Number.isInteger(lane) || lane < 1 || lane > totalLanes) {
    throw new Error(`lane must be between 1 and ${totalLanes}.`);
  }

  return buildWeightedPackageLanes(packageNames, totalLanes)[lane - 1] ?? [];
}

export function buildPackageLanePackageNames(packageNames, lane, totalLanes) {
  return buildLanePackageNames(
    packageNames.filter((packageName) => packageName !== DB_PACKAGE_NAME),
    lane,
    totalLanes
  );
}

export function createDbLaneCommands(dbLane) {
  if (dbLane === 'repository') {
    return [['pnpm', ['--filter', DB_PACKAGE_NAME, 'run', 'test:db:repository']]];
  }
  if (dbLane === 'schema-migration') {
    return [['pnpm', ['--filter', DB_PACKAGE_NAME, 'run', 'test:db:schema-migration']]];
  }
  if (dbLane === 'remaining') {
    return [
      ['pnpm', ['--filter', DB_PACKAGE_NAME, 'run', 'test:db:queue']],
      ['pnpm', ['--filter', DB_PACKAGE_NAME, 'run', 'test:db:search']],
      ['pnpm', ['--filter', DB_PACKAGE_NAME, 'run', 'test:db:integration']],
    ];
  }
  throw new Error(`Unknown DB lane: ${dbLane}`);
}

export function buildWeightedPackageLanes(packageNames, totalLanes) {
  return [...packageNames]
    .sort((a, b) => {
      const weightDelta = getPackageTestWeightMs(b) - getPackageTestWeightMs(a);
      if (weightDelta !== 0) {
        return weightDelta;
      }
      return a.localeCompare(b);
    })
    .reduce(
      (lanes, packageName) => {
        const targetLane = lanes
          .map((lanePackages, index) => ({
            index,
            totalWeight: lanePackages.reduce((sum, name) => sum + getPackageTestWeightMs(name), 0),
          }))
          .sort((a, b) => a.totalWeight - b.totalWeight || a.index - b.index)[0];
        lanes[targetLane.index].push(packageName);
        return lanes;
      },
      Array.from({ length: totalLanes }, () => [])
    )
    .map((lanePackages) => lanePackages.sort((a, b) => a.localeCompare(b)));
}

function getPackageTestWeightMs(packageName) {
  return PACKAGE_TEST_WEIGHTS_MS.get(packageName) ?? DEFAULT_TEST_WEIGHT_MS;
}

export function readWorkspaceManifests(repoRoot = process.cwd()) {
  const manifestsByName = new Map();
  for (const workspaceDir of ['apps', 'packages']) {
    const absoluteWorkspaceDir = path.join(repoRoot, workspaceDir);
    if (!existsSync(absoluteWorkspaceDir)) {
      continue;
    }
    for (const entry of readdirSync(absoluteWorkspaceDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packageJsonPath = path.join(absoluteWorkspaceDir, entry.name, 'package.json');
      if (!existsSync(packageJsonPath)) {
        continue;
      }
      const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      if (typeof manifest.name === 'string') {
        manifestsByName.set(manifest.name, manifest);
      }
    }
  }
  return manifestsByName;
}

function collectAffectedPackages(baseRef, repoRoot, platform) {
  const invocation = createSpawnInvocation(
    'pnpm',
    ['--filter', `...[origin/${baseRef}]`, '--filter', '!./', 'list', '--depth', '-1', '--json'],
    platform
  );
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: invocation.shell,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `pnpm list failed with status ${result.status}`);
  }
  return parsePnpmListJson(result.stdout);
}

function runPnpmTestLane(packageNames, repoRoot, workspaceConcurrency, platform) {
  if (packageNames.length === 0) {
    console.log('No affected testable packages assigned to this unit lane.');
    return 0;
  }

  const filterArgs = packageNames.flatMap((packageName) => ['--filter', packageName]);
  const invocation = createSpawnInvocation(
    'pnpm',
    [
      ...filterArgs,
      `--workspace-concurrency=${workspaceConcurrency}`,
      'run',
      '--if-present',
      'test',
    ],
    platform
  );
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    shell: invocation.shell,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

function runDbLane(dbLane, repoRoot, platform) {
  for (const [command, args] of createDbLaneCommands(dbLane)) {
    const invocation = createSpawnInvocation(command, args, platform);
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: repoRoot,
      shell: invocation.shell,
      stdio: 'inherit',
    });
    if (result.error) {
      console.error(result.error.message);
      return 1;
    }
    if (result.status !== 0) {
      return result.status ?? 1;
    }
  }
  return 0;
}

function parsePositiveInteger(value, optionName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || `${parsed}` !== value) {
    throw new Error(`${optionName} must be a positive integer.`);
  }
  return parsed;
}

export function parseArgs(args) {
  const options = {
    dbLane: undefined,
    dryRun: false,
    lane: undefined,
    mode: 'packages',
    repoRoot: process.cwd(),
    totalLanes: DEFAULT_TOTAL_LANES,
    workspaceConcurrency: DEFAULT_WORKSPACE_CONCURRENCY,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}.`);
      }
      index += 1;
      return value;
    };

    if (arg === '--base-ref') {
      options.baseRef = next();
      continue;
    }
    if (arg === '--mode') {
      options.mode = next();
      continue;
    }
    if (arg === '--db-lane') {
      options.dbLane = next();
      continue;
    }
    if (arg === '--lane') {
      options.lane = parsePositiveInteger(next(), '--lane');
      continue;
    }
    if (arg === '--total-lanes') {
      options.totalLanes = parsePositiveInteger(next(), '--total-lanes');
      continue;
    }
    if (arg === '--workspace-concurrency') {
      options.workspaceConcurrency = parsePositiveInteger(next(), '--workspace-concurrency');
      continue;
    }
    if (arg === '--repo-root') {
      options.repoRoot = path.resolve(next());
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (!options.baseRef) {
    throw new Error('Missing required --base-ref.');
  }
  if (options.mode === 'packages') {
    if (!options.lane) {
      throw new Error('Missing required --lane.');
    }
    buildLanePackageNames([], options.lane, options.totalLanes);
  } else if (options.mode === 'db') {
    if (!options.dbLane) {
      throw new Error('Missing required --db-lane.');
    }
    if (!DB_LANES.has(options.dbLane)) {
      throw new Error(`Unknown DB lane: ${options.dbLane}`);
    }
  } else {
    throw new Error(`Unknown mode: ${options.mode}`);
  }
  return options;
}

export function main(args = process.argv.slice(2), platform = process.platform) {
  let options;
  try {
    options = parseArgs(args);
    const affectedPackages = collectAffectedPackages(options.baseRef, options.repoRoot, platform);
    const testablePackages = filterTestablePackages(
      affectedPackages,
      readWorkspaceManifests(options.repoRoot)
    );
    if (options.mode === 'db') {
      if (!testablePackages.includes(DB_PACKAGE_NAME)) {
        console.log('No affected DB package selected for this unit run.');
        return 0;
      }
      console.log(`Affected DB package selected; DB unit lane: ${options.dbLane}`);
      for (const [command, commandArgs] of createDbLaneCommands(options.dbLane)) {
        console.log(`- ${[command, ...commandArgs].join(' ')}`);
      }
      if (options.dryRun) {
        return 0;
      }
      return runDbLane(options.dbLane, options.repoRoot, platform);
    }

    const lanePackages = buildPackageLanePackageNames(
      testablePackages,
      options.lane,
      options.totalLanes
    );

    console.log(
      `Affected testable packages: ${testablePackages.length}; package unit lane ${options.lane}/${options.totalLanes}: ${lanePackages.length}`
    );
    for (const packageName of lanePackages) {
      console.log(`- ${packageName}`);
    }
    if (options.dryRun) {
      return 0;
    }
    return runPnpmTestLane(lanePackages, options.repoRoot, options.workspaceConcurrency, platform);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
