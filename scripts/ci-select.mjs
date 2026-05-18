import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  expandRiskLanes,
  selectRiskLanesForFiles,
  toRiskLabels,
} from './ci-risk-rules.mjs';
import { splitLines } from './ci-script-utils.mjs';

const execFileAsync = promisify(execFile);

export const CI_DIFF_FILTER = 'ACDMRTUXB';

const BASELINE_COMMANDS = [
  { name: 'lint-ci', command: 'pnpm lint:ci', requiredFor: ['baseline'] },
  { name: 'type-check', command: 'pnpm type-check', requiredFor: ['baseline'] },
  { name: 'build', command: 'pnpm build', requiredFor: ['baseline'] },
  {
    name: 'unit',
    command:
      'TURBO_TEST_MODE=unit pnpm exec turbo run test --summarize --log-order=grouped --concurrency=2',
    requiredFor: ['baseline'],
  },
];

const LANE_COMMANDS = {
  'ci:browser': [
    {
      name: 'browser-vitest',
      command: 'pnpm run test:browser',
      requiredFor: ['ci:browser'],
    },
  ],
  'ci:web-e2e': [
    {
      name: 'web-functional-e2e',
      command:
        'cd apps/web && pnpm exec playwright test --project=functional --workers=2 --grep-invert "@destructive|@stateful"',
      requiredFor: ['ci:web-e2e'],
    },
  ],
  'ci:desktop': [
    {
      name: 'desktop-regression',
      command:
        'cd apps/desktop && pnpm exec playwright test --project=regression --workers=1 --grep-invert "@desktop-embedding-"',
      requiredFor: ['ci:desktop'],
    },
  ],
  'ci:embedding': [
    {
      name: 'desktop-embedding',
      command:
        'cd apps/desktop && pnpm exec playwright test --workers=1 --grep "@desktop-embedding-"',
      requiredFor: ['ci:embedding'],
    },
  ],
  'ci:coverage': [
    {
      name: 'affected-coverage',
      command:
        'TURBO_TEST_MODE=coverage COVERAGE=true pnpm exec turbo run test:coverage --filter="...[<mergeBase>]" --concurrency=4 --summarize --log-order=grouped',
      requiredFor: ['ci:coverage'],
    },
  ],
};

async function defaultRunner(command, args) {
  const { stdout } = await execFileAsync(command, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 50,
  });
  return stdout;
}

function parseFlag(args, index, seen, options) {
  const flag = args[index];
  if (!['--base', '--head', '--format'].includes(flag)) {
    throw new Error(`unknown flag ${flag}`);
  }
  if (seen.has(flag)) {
    throw new Error(`${flag} can only be provided once`);
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  seen.add(flag);
  options[flag.slice(2)] = value;
  return index + 2;
}

export function parseSelectArgs(args = process.argv.slice(2)) {
  const options = {
    base: 'origin/main',
    format: 'json',
    head: 'HEAD',
  };
  const seen = new Set();
  let index = 0;
  while (index < args.length) {
    index = parseFlag(args, index, seen, options);
  }

  if (options.format !== 'json') {
    throw new Error('--format must be json');
  }

  return options;
}

function renderCommand(command, mergeBase) {
  if (
    command.command.includes('<mergeBase>') &&
    !/^[0-9a-f]{40}$/i.test(mergeBase)
  ) {
    throw new Error(`mergeBase must be a 40-character git SHA: ${mergeBase}`);
  }
  return {
    ...command,
    command: command.command.replaceAll('<mergeBase>', mergeBase),
  };
}

export function buildSelection(input) {
  const lanes = selectRiskLanesForFiles(input.files);
  const expandedLanes = expandRiskLanes(lanes);
  const labels = toRiskLabels(lanes);
  const laneCommands = expandedLanes.flatMap((lane) => {
    const commands = LANE_COMMANDS[lane];
    if (!commands) {
      throw new Error(`no commands defined for lane ${lane}`);
    }
    return commands.map((command) => renderCommand(command, input.mergeBase));
  });

  return {
    base: input.base,
    baseSha: input.baseSha,
    head: input.head,
    headSha: input.headSha,
    mergeBase: input.mergeBase,
    files: [...input.files],
    lanes,
    expandedLanes,
    labels,
    commands: [
      ...BASELINE_COMMANDS.map((command) =>
        renderCommand(command, input.mergeBase)
      ),
      ...laneCommands,
    ],
  };
}

export function renderSelectionJson(selection) {
  return `${JSON.stringify(
    {
      base: selection.base,
      baseSha: selection.baseSha,
      head: selection.head,
      headSha: selection.headSha,
      mergeBase: selection.mergeBase,
      files: selection.files,
      lanes: selection.lanes,
      expandedLanes: selection.expandedLanes,
      labels: selection.labels,
      commands: selection.commands,
    },
    null,
    2
  )}\n`;
}

export async function collectGitSelection(options, runner = defaultRunner) {
  const mergeBase = (
    await runner('git', ['merge-base', options.base, options.head])
  ).trim();
  const baseSha = (
    await runner('git', ['rev-parse', options.base])
  ).trim();
  const headSha = (
    await runner('git', ['rev-parse', options.head])
  ).trim();
  const files = splitLines(
    await runner('git', [
      'diff',
      '--name-only',
      `--diff-filter=${CI_DIFF_FILTER}`,
      mergeBase,
      options.head,
    ])
  );

  return buildSelection({
    base: options.base,
    baseSha,
    files,
    head: options.head,
    headSha,
    mergeBase,
  });
}

export async function main(args = process.argv.slice(2)) {
  const options = parseSelectArgs(args);
  const selection = await collectGitSelection(options);
  process.stdout.write(renderSelectionJson(selection));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
