#!/usr/bin/env node

import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  buildSelection,
  collectGitSelection,
  E2E_LANES,
} from './ci-select.mjs';

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export const PLAN_VERSION = 1;

export const PLAN_JOB_IDS = [
  'docs-static',
  'checks',
  'unit_affected',
  'unit_coverage',
  'browser-tests',
  'prepare-web',
  'web-e2e-pr',
  'prepare-desktop',
  'desktop-e2e-pr',
  'merge-reports',
];

export const UNIT_MODE_CHANGED_TESTS = 'changed-unit-tests';
export const UNIT_MODE_AFFECTED_PACKAGES = 'affected-packages';

export const JOBS_BY_LANE = new Map([
  ['docs-static', ['docs-static']],
  ['unit', ['unit_affected']],
  ['coverage-db', ['unit_coverage']],
  ['coverage-full', ['unit_coverage']],
  ['browser', ['browser-tests']],
  ['web-smoke', ['prepare-web', 'web-e2e-pr']],
  ['web-file-explorer-persistence', ['prepare-web', 'web-e2e-pr']],
  ['web-import-indexing', ['prepare-web', 'web-e2e-pr']],
  ['web-assistant-state', ['prepare-web', 'web-e2e-pr']],
  ['web-settings-state', ['prepare-web', 'web-e2e-pr']],
  ['web-db-startup', ['prepare-web', 'web-e2e-pr']],
  ['web-destructive-reset', ['prepare-web', 'web-e2e-pr']],
  ['web-full-regression', ['prepare-web', 'web-e2e-pr']],
  ['desktop-smoke', ['prepare-desktop', 'desktop-e2e-pr']],
  ['desktop-ipc-reset', ['prepare-desktop', 'desktop-e2e-pr']],
  ['desktop-runtime-hosts', ['prepare-desktop', 'desktop-e2e-pr']],
  ['desktop-db-storage', ['prepare-desktop', 'desktop-e2e-pr']],
  ['desktop-full-regression', ['prepare-desktop', 'desktop-e2e-pr']],
  ['desktop-embedding-diagnostics', ['prepare-desktop', 'desktop-e2e-pr']],
  ['desktop-llm-host-recovery', ['prepare-desktop', 'desktop-e2e-pr']],
]);

// Lane commands are a closed, hardcoded allowlist. Do not compose these from
// PR metadata, labels, changed file paths, or other user-controlled input.
const WEB_LANE_COMMANDS = new Map([
  ['critical-smoke', 'pnpm --filter @brainstrike/web run test:e2e:lane:smoke'],
  ['web-smoke', 'pnpm --filter @brainstrike/web run test:e2e:lane:smoke'],
  [
    'web-file-explorer-persistence',
    'pnpm --filter @brainstrike/web run test:e2e:lane:file-explorer-persistence',
  ],
  [
    'web-import-indexing',
    'pnpm --filter @brainstrike/web run test:e2e:lane:import-indexing',
  ],
  [
    'web-assistant-state',
    'pnpm --filter @brainstrike/web run test:e2e:lane:assistant-state',
  ],
  [
    'web-settings-state',
    'pnpm --filter @brainstrike/web run test:e2e:lane:settings-state',
  ],
  ['web-db-startup', 'pnpm --filter @brainstrike/web run test:e2e:lane:db-startup'],
  [
    'web-destructive-reset',
    'pnpm --filter @brainstrike/web run test:e2e:lane:destructive-reset',
  ],
  [
    'web-full-regression',
    'pnpm --filter @brainstrike/web run test:e2e:lane:full-regression',
  ],
]);

const DESKTOP_LANE_COMMANDS = new Map([
  ['desktop-smoke', 'pnpm run test:e2e:lane:smoke'],
  ['desktop-ipc-reset', 'pnpm run test:e2e:lane:ipc-reset'],
  ['desktop-runtime-hosts', 'pnpm run test:e2e:lane:runtime-hosts'],
  ['desktop-db-storage', 'pnpm run test:e2e:lane:db-storage'],
  [
    'desktop-full-regression',
    'pnpm exec playwright test --project=regression --workers=1 --retries=0 --max-failures=1 --global-timeout=720000 --grep-invert="@desktop-embedding-"',
  ],
  [
    'desktop-embedding-diagnostics',
    'pnpm exec playwright test e2e/embedding-worker-renderer.smoke.desktop.test.ts e2e/embedding-worker-renderer.backfill-search.desktop.test.ts e2e/embedding-worker-renderer.memory.desktop.test.ts e2e/embedding-worker-renderer.diagnostics.desktop.test.ts e2e/embedding-worker-renderer.crash-a.desktop.test.ts --project=regression --grep "@desktop-embedding-lifecycle|@desktop-embedding-backfill|@desktop-embedding-search|@desktop-embedding-recovery|@desktop-embedding-memory|@desktop-embedding-mixed"',
  ],
  [
    'desktop-llm-host-recovery',
    'pnpm exec playwright test e2e/llm-host-renderer.test.ts --project=regression --grep "@desktop-llm-host-recovery"',
  ],
]);

const DESKTOP_LANE_DISPLAYS = new Map([
  ['desktop-smoke', 107],
  ['desktop-ipc-reset', 108],
  ['desktop-runtime-hosts', 109],
  ['desktop-db-storage', 110],
  ['desktop-embedding-diagnostics', 111],
  ['desktop-llm-host-recovery', 112],
  ['desktop-full-regression', 120],
]);

const DESKTOP_FULL_REGRESSION_SHARD_TOTAL = 4;

function stripCiPrefix(lane) {
  return lane.startsWith('ci:') ? lane.slice(3) : lane;
}

function unique(values) {
  return [...new Set(values)];
}

function isWebLane(lane) {
  return WEB_LANE_COMMANDS.has(lane);
}

function isDesktopLane(lane) {
  return DESKTOP_LANE_COMMANDS.has(lane);
}

function planJobKey(jobId) {
  return jobId.replaceAll('-', '_');
}

function githubOutputKey(jobId) {
  return `run-${jobId.replaceAll('_', '-')}`;
}

function buildMatrixEntry(lane, command, extra = {}) {
  const e2eMetadata = E2E_LANES[lane] ?? {};
  return {
    lane,
    command,
    owner: e2eMetadata.owner ?? 'ci-platform',
    tagContract: e2eMetadata.tagContract ?? lane,
    timeoutMinutes: lane.includes('full-regression') ? 15 : 8,
    ...extra,
  };
}

function buildWebMatrix(e2eLanes) {
  const lanes = unique(
    e2eLanes
      .map((lane) => (lane === 'critical-smoke' ? 'web-smoke' : lane))
      .filter(isWebLane)
  );

  return {
    include: lanes.map((lane) =>
      buildMatrixEntry(lane, WEB_LANE_COMMANDS.get(lane), {
        timeoutMinutes: lane === 'web-full-regression' ? 30 : 12,
      })
    ),
  };
}

function resolveDesktopLaneTimeoutMinutes(lane) {
  if (lane === 'desktop-embedding-diagnostics') {
    return 20;
  }
  if (lane === 'desktop-full-regression') {
    return 15;
  }
  return 8;
}

function buildDesktopMatrix(e2eLanes) {
  const lanes = unique(e2eLanes.filter(isDesktopLane));
  const include = [];

  for (const lane of lanes) {
    if (lane === 'desktop-full-regression') {
      const command = DESKTOP_LANE_COMMANDS.get(lane);
      const metadata = E2E_LANES[lane] ?? {};
      for (let shardIndex = 1; shardIndex <= DESKTOP_FULL_REGRESSION_SHARD_TOTAL; shardIndex++) {
        include.push(
          buildMatrixEntry(
            `${lane}-shard-${shardIndex}-of-${DESKTOP_FULL_REGRESSION_SHARD_TOTAL}`,
            `${command} --shard=${shardIndex}/${DESKTOP_FULL_REGRESSION_SHARD_TOTAL}`,
            {
              display: DESKTOP_LANE_DISPLAYS.get(lane) + shardIndex - 1,
              owner: metadata.owner ?? 'desktop-platform',
              shardIndex,
              shardTotal: DESKTOP_FULL_REGRESSION_SHARD_TOTAL,
              tagContract: metadata.tagContract ?? lane,
              timeoutMinutes: resolveDesktopLaneTimeoutMinutes(lane),
            }
          )
        );
      }
      continue;
    }

    include.push(
      buildMatrixEntry(lane, DESKTOP_LANE_COMMANDS.get(lane), {
        display: DESKTOP_LANE_DISPLAYS.get(lane),
        timeoutMinutes: resolveDesktopLaneTimeoutMinutes(lane),
      })
    );
  }

  return {
    include,
  };
}

function selectedJobIdsForLanes(lanes) {
  const selected = new Set();
  for (const lane of lanes) {
    for (const jobId of JOBS_BY_LANE.get(lane) ?? []) {
      selected.add(jobId);
    }
  }
  return selected;
}

function buildJobs(selectedJobIds) {
  const jobs = {};
  for (const jobId of PLAN_JOB_IDS) {
    jobs[planJobKey(jobId)] = selectedJobIds.has(jobId);
  }
  return jobs;
}

function buildRisk(selection) {
  return {
    category: selection.riskProfile.category,
    level: selection.riskProfile.riskLevel,
    domains: selection.riskProfile.domains,
    reasons: selection.files.map((file) => `changed:${file}`),
  };
}

function normalizePrGateLanes(lanes, eventName) {
  if (eventName !== 'pull_request') {
    return lanes;
  }
  const prLanes = lanes.filter(
    (lane) => !['coverage', 'coverage-db', 'coverage-full'].includes(lane)
  );
  if (prLanes.length !== lanes.length && !prLanes.includes('unit')) {
    prLanes.push('unit');
  }
  return unique(prLanes);
}

function resolveUnitMode(selection) {
  return selection.localCommandNames.includes('changed-unit-tests')
    ? UNIT_MODE_CHANGED_TESTS
    : UNIT_MODE_AFFECTED_PACKAGES;
}

export function buildCiPlan(input) {
  const selection = buildSelection(input);
  const eventName = input.eventName ?? 'pull_request';
  const isDocsOnly = selection.riskProfile.category === 'docs-only';
  const rawLanes = isDocsOnly
    ? ['docs-static']
    : unique(selection.expandedLanes.map(stripCiPrefix));
  const lanes = normalizePrGateLanes(rawLanes, eventName);
  const e2eLanes = selection.riskProfile.e2eLanes.filter(
    (lane) => lane !== 'long-soak-release-only'
  );
  const webE2eMatrix = buildWebMatrix(e2eLanes);
  const desktopE2eMatrix = buildDesktopMatrix(e2eLanes);
  const selectedJobIds = selectedJobIdsForLanes(lanes);

  if (!isDocsOnly) {
    selectedJobIds.add('checks');
  }
  if (webE2eMatrix.include.length > 0) {
    selectedJobIds.add('prepare-web');
    selectedJobIds.add('web-e2e-pr');
    selectedJobIds.add('merge-reports');
  }
  if (desktopE2eMatrix.include.length > 0) {
    selectedJobIds.add('prepare-desktop');
    selectedJobIds.add('desktop-e2e-pr');
    selectedJobIds.add('merge-reports');
  }

  const requiredJobs = ['plan', ...PLAN_JOB_IDS.filter((jobId) => selectedJobIds.has(jobId))];

  return {
    planVersion: PLAN_VERSION,
    selectionSource: input.selectionSource ?? 'git-diff',
    eventName,
    base: selection.base,
    head: selection.head,
    baseSha: selection.baseSha,
    headSha: selection.headSha,
    mergeBase: selection.mergeBase,
    changedFiles: selection.files,
    risk: buildRisk(selection),
    lanes,
    requiredJobs,
    jobs: buildJobs(selectedJobIds),
    unitMode: resolveUnitMode(selection),
    webE2eMatrix,
    desktopE2eMatrix,
    localCommands: selection.commands.map((command) => ({ ...command })),
  };
}

export function renderPlanJson(plan) {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

function compactJson(value) {
  return JSON.stringify(value);
}

export function renderGithubOutputs(plan) {
  const lines = [
    `plan-json=${compactJson(plan)}`,
    `required-jobs-json=${compactJson(plan.requiredJobs)}`,
  ];

  for (const jobId of PLAN_JOB_IDS) {
    lines.push(`${githubOutputKey(jobId)}=${plan.jobs[planJobKey(jobId)] ? 'true' : 'false'}`);
  }

  lines.push(`unit-mode=${plan.unitMode}`);
  lines.push(`web-e2e-matrix=${compactJson(plan.webE2eMatrix)}`);
  lines.push(`desktop-e2e-matrix=${compactJson(plan.desktopE2eMatrix)}`);
  return `${lines.join('\n')}\n`;
}

const DEFAULT_OPTIONS = {
  base: 'origin/main',
  eventName: 'pull_request',
  head: 'HEAD',
};

function parseFiles(value) {
  return value
    .split(',')
    .map((file) => file.trim())
    .filter(Boolean);
}

function parseFlag(args, index, seen, options) {
  const flag = args[index];
  if (!['--base', '--head', '--event', '--github-output', '--files'].includes(flag)) {
    throw new Error(`unknown flag ${flag}`);
  }
  if (seen.has(flag)) {
    throw new Error(`${flag} can only be provided once`);
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  seen.add(flag);
  if (flag === '--event') {
    options.eventName = value;
  } else if (flag === '--files') {
    options.files = parseFiles(value);
  } else if (flag === '--github-output') {
    options.githubOutput = value;
  } else {
    options[flag.slice(2)] = value;
  }
  return index + 2;
}

export function parsePlanArgs(args = process.argv.slice(2)) {
  const options = { ...DEFAULT_OPTIONS };
  const seen = new Set();
  let index = 0;
  while (index < args.length) {
    index = parseFlag(args, index, seen, options);
  }
  return options;
}

export async function collectCiPlan(options, runner) {
  if (Array.isArray(options.files)) {
    return buildCiPlan({
      base: options.base,
      baseSha: SHA_PATTERN.test(options.baseSha ?? '') ? options.baseSha : '1'.repeat(40),
      eventName: options.eventName,
      files: options.files,
      head: options.head,
      headSha: SHA_PATTERN.test(options.headSha ?? '') ? options.headSha : '2'.repeat(40),
      mergeBase: SHA_PATTERN.test(options.mergeBase ?? '') ? options.mergeBase : '3'.repeat(40),
      selectionSource: 'files-fixture',
    });
  }

  const selection = await collectGitSelection(options, runner);
  return buildCiPlan({
    base: selection.base,
    baseSha: selection.baseSha,
    eventName: options.eventName,
    files: selection.files,
    head: selection.head,
    headSha: selection.headSha,
    mergeBase: selection.mergeBase,
    selectionSource: 'git-diff',
  });
}

export async function main(args = process.argv.slice(2)) {
  const options = parsePlanArgs(args);
  const plan = await collectCiPlan(options);
  process.stdout.write(renderPlanJson(plan));
  if (options.githubOutput) {
    await appendFile(options.githubOutput, renderGithubOutputs(plan));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
