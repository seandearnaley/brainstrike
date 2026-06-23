#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createSpawnInvocation } from './spawn-command.mjs';
import {
  dbCoverageLaneDefinitions,
  dbUnitLaneDefinitions,
} from '../packages/db/scripts/db-test-lane-manifest.mjs';

const DEFAULT_TOTAL_LANES = 4;
const DEFAULT_WORKSPACE_CONCURRENCY = 2;
const DEFAULT_TEST_WEIGHT_MS = 1000;
const DB_PACKAGE_NAME = '@brainstrike/db';
const COVERAGE_SCRIPT_NAME = 'test:coverage';
const UNIT_DEPENDENT_EXPANSION_TRIGGERS = new Set([
  '@brainstrike/db',
  '@brainstrike/types',
  '@brainstrike/utils',
]);
const DB_DEPENDENT_EXPANSION_SAFE_PATH_PREFIXES = [
  'packages/db/__tests__/',
  'packages/db/scripts/',
  'packages/db/src/repositories/',
];
const TURSO_SCHEMA_INTERNAL_SOURCE_PATHS = [
  'packages/db/src/turso/schema-baseline.ts',
  'packages/db/src/turso/schema-ledger.ts',
];
const TURSO_SCHEMA_INTERNAL_SOURCE_PATH_SET = new Set(TURSO_SCHEMA_INTERNAL_SOURCE_PATHS);
const DB_QUEUE_INTERNAL_SOURCE_PATHS = ['packages/db/src/queue/chunk-embedding-job-batch-impl.ts'];
const DB_QUEUE_INTERNAL_SOURCE_PATH_SET = new Set(DB_QUEUE_INTERNAL_SOURCE_PATHS);
const DB_DEPENDENT_EXPANSION_PUBLIC_PATHS = new Set(['packages/db/src/repositories/index.ts']);
const CI_DB_LANE_GROUPS = new Map([
  ['repository', ['repository']],
  ['schema-migration', ['schema-migration']],
  ['remaining', ['queue', 'search', 'integration']],
]);
const DB_LANES = new Set(CI_DB_LANE_GROUPS.keys());
const CI_DB_COVERAGE_LANES = [...dbCoverageLaneDefinitions.laneOrder];
const DB_COVERAGE_LANES = new Set(CI_DB_COVERAGE_LANES);
const CI_DB_GROUP_BY_MANIFEST_LANE = new Map(
  [...CI_DB_LANE_GROUPS.entries()].flatMap(([groupName, manifestLanes]) =>
    manifestLanes.map((manifestLane) => [manifestLane, groupName])
  )
);
const KNOWN_DB_SOURCE_LANE_RULES = [
  {
    pattern: /^packages\/db\/src\/db-provider(?:-[\w-]+)?\.(?:ts|tsx)$/,
    unitLane: 'integration',
    coverageLane: 'architecture',
  },
  {
    pattern: /^packages\/db\/src\/repositories\/turso-[\w-]+\.ts$/,
    unitLane: 'repository',
    coverageLane: 'repositories',
  },
  {
    files: TURSO_SCHEMA_INTERNAL_SOURCE_PATH_SET,
    unitLanes: ['repository', 'search'],
    coverageLanes: ['repositories', 'search'],
  },
  {
    files: DB_QUEUE_INTERNAL_SOURCE_PATH_SET,
    unitLane: 'queue',
    coverageLane: 'queue',
  },
];
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
const SAFE_TURBO_PACKAGE_FILTER = /^@brainstrike\/[a-z0-9-]+$/;

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

export function filterCoveragePackages(packageNames, manifestsByName) {
  return packageNames.filter((name) => {
    const manifest = manifestsByName.get(name);
    return (
      typeof manifest?.scripts?.[COVERAGE_SCRIPT_NAME] === 'string' &&
      manifest.scripts[COVERAGE_SCRIPT_NAME].length > 0
    );
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
  const manifestLanes = CI_DB_LANE_GROUPS.get(dbLane);
  if (!manifestLanes) {
    throw new Error(`Unknown DB lane: ${dbLane}`);
  }
  return manifestLanes.map((laneName) => [
    'pnpm',
    ['--filter', DB_PACKAGE_NAME, 'run', `test:db:${laneName}`],
  ]);
}

export function createDbCoverageLaneCommands(dbCoverageLane) {
  if (!DB_COVERAGE_LANES.has(dbCoverageLane)) {
    throw new Error(`Unknown DB coverage lane: ${dbCoverageLane}`);
  }
  return [
    ['pnpm', ['--filter', DB_PACKAGE_NAME, 'run', `test:coverage:db:${dbCoverageLane}`]],
  ];
}

export function listCiDbLaneGroups() {
  return [...CI_DB_LANE_GROUPS.entries()].map(([groupName, manifestLanes]) => ({
    groupName,
    manifestLanes: [...manifestLanes],
  }));
}

export function listCiDbCoverageLanes() {
  return [...CI_DB_COVERAGE_LANES];
}

function matchDbUnitLaneForTestFile(testFile) {
  const matchedLanes = dbUnitLaneDefinitions.filter((lane) =>
    lane.matches.some((pattern) => pattern.test(testFile))
  );
  return matchedLanes.length === 1 ? matchedLanes[0].name : null;
}

function matchDbCoverageLaneForTestFile(testFile) {
  const overrideLane = Object.entries(
    dbCoverageLaneDefinitions.coverageOverridesByLane ?? {}
  ).find(([, files]) => files.includes(testFile))?.[0];
  if (overrideLane) {
    return overrideLane;
  }
  const unitLane = matchDbUnitLaneForTestFile(testFile);
  return unitLane ? dbCoverageLaneDefinitions.coverageDefaultsByUnitLane?.[unitLane] : null;
}

function getKnownDbLaneSelection(filePath) {
  const testPrefix = 'packages/db/__tests__/';
  if (filePath.startsWith(testPrefix)) {
    const testFile = filePath.slice(testPrefix.length);
    const unitLane = matchDbUnitLaneForTestFile(testFile);
    const coverageLane = matchDbCoverageLaneForTestFile(testFile);
    return unitLane && coverageLane ? { unitLanes: [unitLane], coverageLanes: [coverageLane] } : null;
  }

  return (
    KNOWN_DB_SOURCE_LANE_RULES.find(
      (rule) => rule.pattern?.test(filePath) || rule.files?.has(filePath)
    ) ?? null
  );
}

function selectKnownDbLaneSelections(changedFiles = []) {
  const dbFiles = changedFiles.filter((filePath) => filePath.startsWith('packages/db/'));
  if (dbFiles.length === 0) {
    return null;
  }

  const selections = [];
  for (const filePath of dbFiles) {
    const selection = getKnownDbLaneSelection(filePath);
    if (!selection) {
      return null;
    }
    selections.push(selection);
  }
  return selections;
}

export function selectDbUnitCiLanes(changedFiles = []) {
  const selections = selectKnownDbLaneSelections(changedFiles);
  if (!selections) {
    return [...DB_LANES];
  }

  const selectedGroups = new Set(
    selections.flatMap((selection) =>
      (selection.unitLanes ?? [selection.unitLane]).map((unitLane) =>
        CI_DB_GROUP_BY_MANIFEST_LANE.get(unitLane)
      )
    )
  );
  return [...CI_DB_LANE_GROUPS.keys()].filter((groupName) => selectedGroups.has(groupName));
}

export function selectDbCoverageCiLanes(changedFiles = []) {
  const selections = selectKnownDbLaneSelections(changedFiles);
  if (!selections) {
    return listCiDbCoverageLanes();
  }

  const selectedCoverageLanes = new Set(
    selections.flatMap((selection) => selection.coverageLanes ?? [selection.coverageLane])
  );
  return CI_DB_COVERAGE_LANES.filter((coverageLane) => selectedCoverageLanes.has(coverageLane));
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

export function buildAffectedPackageFilter(baseRef, { includeDependents = false } = {}) {
  return includeDependents ? `...[origin/${baseRef}]` : `[origin/${baseRef}]`;
}

export function buildTurboBuildFilterOutput(packageNames) {
  if (packageNames.length === 0) {
    throw new Error('Cannot build a Turbo filter list for an empty package lane.');
  }
  return packageNames
    .map((packageName) => {
      if (!SAFE_TURBO_PACKAGE_FILTER.test(packageName)) {
        throw new Error(`Unsafe package name for Turbo filter: ${packageName}`);
      }
      return `--filter=${packageName}`;
    })
    .join(' ');
}

export function dbChangeRequiresDependentUnitExpansion(changedFiles = []) {
  const dbChangedFiles = changedFiles.filter((filePath) => filePath.startsWith('packages/db/'));
  if (dbChangedFiles.length === 0) {
    return true;
  }
  return dbChangedFiles.some((filePath) => {
    if (DB_DEPENDENT_EXPANSION_PUBLIC_PATHS.has(filePath)) {
      return true;
    }
    if (TURSO_SCHEMA_INTERNAL_SOURCE_PATH_SET.has(filePath)) {
      return false;
    }
    if (DB_QUEUE_INTERNAL_SOURCE_PATH_SET.has(filePath)) {
      return false;
    }
    if (DB_DEPENDENT_EXPANSION_SAFE_PATH_PREFIXES.some((prefix) => filePath.startsWith(prefix))) {
      return false;
    }
    return true;
  });
}

export function modeIncludesDependentPackages(mode, directlyChangedPackages = [], changedFiles) {
  if (mode === 'packages' || mode === 'db') {
    if (
      directlyChangedPackages.includes(DB_PACKAGE_NAME) &&
      Array.isArray(changedFiles) &&
      !dbChangeRequiresDependentUnitExpansion(changedFiles)
    ) {
      return directlyChangedPackages.some(
        (packageName) =>
          packageName !== DB_PACKAGE_NAME && UNIT_DEPENDENT_EXPANSION_TRIGGERS.has(packageName)
      );
    }
    return directlyChangedPackages.some((packageName) =>
      UNIT_DEPENDENT_EXPANSION_TRIGGERS.has(packageName)
    );
  }
  if (mode === 'coverage-packages' || mode === 'coverage-db') {
    return false;
  }
  throw new Error(`Unknown mode: ${mode}`);
}

function collectAffectedPackages(baseRef, repoRoot, platform, { includeDependents = false } = {}) {
  const affectedFilter = buildAffectedPackageFilter(baseRef, { includeDependents });
  const invocation = createSpawnInvocation(
    'pnpm',
    ['--filter', affectedFilter, '--filter', '!./', 'list', '--depth', '-1', '--json'],
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

function collectChangedFiles(baseRef, repoRoot, platform) {
  const invocation = createSpawnInvocation(
    'git',
    ['diff', '--name-only', `origin/${baseRef}...HEAD`],
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
    throw new Error(result.stderr || result.stdout || `git diff failed with status ${result.status}`);
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
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

function runPnpmCoverageLane(packageNames, repoRoot, workspaceConcurrency, platform) {
  if (packageNames.length === 0) {
    console.log('No directly affected packages assigned to this coverage lane.');
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
      COVERAGE_SCRIPT_NAME,
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

export function runCommandSequence(commands, repoRoot, platform, run = spawnSync) {
  let exitStatus = 0;
  for (const [command, args] of commands) {
    const invocation = createSpawnInvocation(command, args, platform);
    const result = run(invocation.command, invocation.args, {
      cwd: repoRoot,
      shell: invocation.shell,
      stdio: 'inherit',
    });
    if (result.error) {
      console.error(result.error.message);
      exitStatus = exitStatus || 1;
      continue;
    }
    if (result.status !== 0) {
      exitStatus = exitStatus || result.status || 1;
    }
  }
  return exitStatus;
}

function runDbLane(dbLane, repoRoot, platform) {
  return runCommandSequence(createDbLaneCommands(dbLane), repoRoot, platform);
}

function runDbCoverageLane(dbCoverageLane, repoRoot, platform) {
  return runCommandSequence(createDbCoverageLaneCommands(dbCoverageLane), repoRoot, platform);
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
    dbCoverageLane: undefined,
    dbLane: undefined,
    dryRun: false,
    githubOutput: undefined,
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
    if (arg === '--db-coverage-lane') {
      options.dbCoverageLane = next();
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
    if (arg === '--github-output') {
      options.githubOutput = path.resolve(next());
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
  if (options.mode === 'packages' || options.mode === 'coverage-packages') {
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
  } else if (options.mode === 'coverage-db') {
    if (!options.dbCoverageLane) {
      throw new Error('Missing required --db-coverage-lane.');
    }
    if (!DB_COVERAGE_LANES.has(options.dbCoverageLane)) {
      throw new Error(`Unknown DB coverage lane: ${options.dbCoverageLane}`);
    }
  } else {
    throw new Error(`Unknown mode: ${options.mode}`);
  }
  return options;
}

function writeGithubOutput(outputPath, values) {
  if (!outputPath) {
    return;
  }
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  appendFileSync(outputPath, `${lines.join('\n')}\n`);
}

export function main(args = process.argv.slice(2), platform = process.platform) {
  let options;
  try {
    options = parseArgs(args);
    const directlyChangedPackages = collectAffectedPackages(options.baseRef, options.repoRoot, platform);
    const changedFiles = collectChangedFiles(options.baseRef, options.repoRoot, platform);
    const includeDependents = modeIncludesDependentPackages(
      options.mode,
      directlyChangedPackages,
      changedFiles
    );
    const affectedPackages = includeDependents
      ? collectAffectedPackages(options.baseRef, options.repoRoot, platform, { includeDependents: true })
      : directlyChangedPackages;
    const manifestsByName = readWorkspaceManifests(options.repoRoot);
    const testablePackages = filterTestablePackages(affectedPackages, manifestsByName);
    const coveragePackages = filterCoveragePackages(affectedPackages, manifestsByName);
    if (options.mode === 'db') {
      if (!testablePackages.includes(DB_PACKAGE_NAME)) {
        console.log('No affected DB package selected for this unit run.');
        writeGithubOutput(options.githubOutput, { has_work: 'false' });
        return 0;
      }
      const selectedDbLanes = selectDbUnitCiLanes(changedFiles);
      if (!selectedDbLanes.includes(options.dbLane)) {
        console.log(
          `Affected DB package selected, but DB unit lane ${options.dbLane} is not in the selected lane set: ${selectedDbLanes.join(', ')}`
        );
        writeGithubOutput(options.githubOutput, { has_work: 'false' });
        return 0;
      }
      writeGithubOutput(options.githubOutput, {
        build_filters: buildTurboBuildFilterOutput([DB_PACKAGE_NAME]),
        has_work: 'true',
      });
      console.log(`Affected DB package selected; DB unit lane: ${options.dbLane}`);
      for (const [command, commandArgs] of createDbLaneCommands(options.dbLane)) {
        console.log(`- ${[command, ...commandArgs].join(' ')}`);
      }
      if (options.dryRun) {
        return 0;
      }
      return runDbLane(options.dbLane, options.repoRoot, platform);
    }
    if (options.mode === 'coverage-db') {
      if (!coveragePackages.includes(DB_PACKAGE_NAME)) {
        console.log('No directly affected DB package selected for this coverage run.');
        writeGithubOutput(options.githubOutput, { has_work: 'false' });
        return 0;
      }
      const selectedDbCoverageLanes = selectDbCoverageCiLanes(changedFiles);
      if (!selectedDbCoverageLanes.includes(options.dbCoverageLane)) {
        console.log(
          `Affected DB package selected, but DB coverage lane ${options.dbCoverageLane} is not in the selected lane set: ${selectedDbCoverageLanes.join(', ')}`
        );
        writeGithubOutput(options.githubOutput, { has_work: 'false' });
        return 0;
      }
      writeGithubOutput(options.githubOutput, {
        build_filters: buildTurboBuildFilterOutput([DB_PACKAGE_NAME]),
        has_work: 'true',
      });
      console.log(`Affected DB package selected; DB coverage lane: ${options.dbCoverageLane}`);
      for (const [command, commandArgs] of createDbCoverageLaneCommands(options.dbCoverageLane)) {
        console.log(`- ${[command, ...commandArgs].join(' ')}`);
      }
      if (options.dryRun) {
        return 0;
      }
      return runDbCoverageLane(options.dbCoverageLane, options.repoRoot, platform);
    }

    if (options.mode === 'coverage-packages') {
      const lanePackages = buildPackageLanePackageNames(
        coveragePackages,
        options.lane,
        options.totalLanes
      );

      console.log(
        `Directly affected coverage packages: ${coveragePackages.length}; package coverage lane ${options.lane}/${options.totalLanes}: ${lanePackages.length}`
      );
      writeGithubOutput(options.githubOutput, {
        ...(lanePackages.length > 0
          ? { build_filters: buildTurboBuildFilterOutput(lanePackages) }
          : {}),
        has_work: lanePackages.length > 0 ? 'true' : 'false',
      });
      for (const packageName of lanePackages) {
        console.log(`- ${packageName}`);
      }
      if (options.dryRun) {
        return 0;
      }
      return runPnpmCoverageLane(
        lanePackages,
        options.repoRoot,
        options.workspaceConcurrency,
        platform
      );
    }

    const lanePackages = buildPackageLanePackageNames(
      testablePackages,
      options.lane,
      options.totalLanes
    );

    console.log(
      `Affected testable packages: ${testablePackages.length}; package unit lane ${options.lane}/${options.totalLanes}: ${lanePackages.length}`
    );
    writeGithubOutput(options.githubOutput, {
      ...(lanePackages.length > 0 ? { build_filters: buildTurboBuildFilterOutput(lanePackages) } : {}),
      has_work: lanePackages.length > 0 ? 'true' : 'false',
    });
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
