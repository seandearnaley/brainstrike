import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  expandRiskLanes,
  selectRiskProfileForFiles,
  selectRiskLanesForFiles,
  toRiskLabels,
} from './ci-risk-rules.mjs';
import { splitLines } from './ci-script-utils.mjs';

const execFileAsync = promisify(execFile);

export const CI_DIFF_FILTER = 'ACDMRTUXB';

export const E2E_LANES = {
  'critical-smoke': {
    command: 'pnpm --filter @brainstrike/web exec playwright test --project=functional --grep "@smoke" --workers=2',
    owner: 'applications',
    tagContract: '@smoke',
  },
  'web-functional-stateful': {
    command:
      'cd apps/web && pnpm exec playwright test --project=functional --workers=2 --grep-invert "@destructive|@stateful" && pnpm exec playwright test --project=functional --workers=1 --grep "@stateful"',
    owner: 'applications',
    tagContract: 'functional plus @stateful',
  },
  'desktop-smoke-regression': {
    command: 'pnpm --filter @brainstrike/desktop exec playwright test --project=smoke',
    owner: 'desktop-platform',
    tagContract: '@smoke',
  },
  'desktop-embedding-diagnostics': {
    command:
      'pnpm --filter @brainstrike/desktop exec playwright test e2e/embedding-worker-renderer.smoke.desktop.test.ts e2e/embedding-worker-renderer.backfill-search.desktop.test.ts e2e/embedding-worker-renderer.memory.desktop.test.ts e2e/embedding-worker-renderer.diagnostics.desktop.test.ts --project=regression --grep "@desktop-embedding-lifecycle|@desktop-embedding-backfill|@desktop-embedding-search|@desktop-embedding-recovery|@desktop-embedding-memory|@desktop-embedding-mixed"',
    owner: 'indexing',
    tagContract: '@desktop-embedding-* required groups only; crash diagnostics stay release-only',
  },
  'desktop-llm-host-recovery': {
    command:
      'pnpm --filter @brainstrike/desktop exec playwright test e2e/llm-host-renderer.test.ts --project=regression --grep "@desktop-llm-host-recovery"',
    owner: 'desktop-platform',
    tagContract: '@desktop-llm-host-recovery focused hidden LLM host restart path only',
  },
  'destructive-reset': {
    command:
      '(cd apps/web && pnpm exec playwright test --project=functional --workers=1 --retries=0 --max-failures=1 --global-timeout=600000 --grep "@destructive") && (cd apps/desktop && pnpm exec playwright test e2e/factory-reset.desktop.test.ts --project=regression --workers=1 --retries=0 --max-failures=1 --global-timeout=600000 --grep "@destructive")',
    owner: 'data-platform',
    tagContract: '@destructive web reset plus desktop factory reset',
  },
  'long-soak-release-only': {
    command: 'pnpm test:e2e',
    owner: 'release',
    tagContract: 'explicit release/full-risk only',
  },
};

export const LOCAL_PROOF_COMMANDS = {
  'diff-check': {
    name: 'diff-check',
    command: 'git diff --check',
    budgetMs: 30_000,
    owner: 'tooling',
    requiredFor: ['all'],
  },
  'docs-static': {
    name: 'docs-static',
    command: 'git diff --check -- docs apps/docs README.md AGENTS.md CLAUDE.md',
    budgetMs: 30_000,
    owner: 'documentation',
    requiredFor: ['docs-only'],
  },
  'ci-script-tests': {
    name: 'ci-script-tests',
    command:
      'node --test scripts/__tests__/ci-risk-rules.test.mjs scripts/__tests__/ci-select.test.mjs scripts/__tests__/ci-timing-summary.test.mjs scripts/__tests__/ci-proof-timing-summary.test.mjs scripts/__tests__/ci-proof.test.mjs scripts/__tests__/turbo-run-diagnostics.test.mjs scripts/__tests__/check-ci-workflow-contracts.test.mjs scripts/__tests__/check-ci-risk-fixtures.test.mjs scripts/__tests__/run-changed-unit-tests.test.mjs scripts/__tests__/ci-calibrate-proof-commands.test.mjs scripts/__tests__/ci-calibration-summary.test.mjs scripts/__tests__/ci-risk-audit.test.mjs && pnpm run ci:risk-fixtures',
    budgetMs: 120_000,
    owner: 'tooling',
    requiredFor: ['config-tooling', 'full-release-high-risk'],
  },
  'changed-unit-tests': {
    name: 'changed-unit-tests',
    command: 'node scripts/run-changed-unit-tests.mjs --base <mergeBase> --head HEAD',
    budgetMs: 180_000,
    owner: 'test-only',
    requiredFor: ['isolated-unit-test-only'],
  },
  'workflow-contracts': {
    name: 'workflow-contracts',
    command:
      'node --test scripts/__tests__/check-ci-workflow-contracts.test.mjs && pnpm run lint:ci-workflow-contracts',
    budgetMs: 180_000,
    owner: 'ci-platform',
    requiredFor: ['config-tooling', 'full-release-high-risk'],
  },
  'assistant-contract-tests': {
    name: 'assistant-contract-tests',
    command:
      'pnpm --filter @brainstrike/assistant-contract test && pnpm --filter @brainstrike/agent test',
    budgetMs: 180_000,
    owner: 'assistant',
    requiredFor: ['assistant-contract-runtime'],
  },
  'app-shell-tests': {
    name: 'app-shell-tests',
    command: 'pnpm --filter @brainstrike/app-shell test',
    budgetMs: 180_000,
    owner: 'workspace-experience',
    requiredFor: ['assistant-contract-runtime'],
  },
  'indexing-tests': {
    name: 'indexing-tests',
    command:
      'pnpm --filter @brainstrike/indexing-contract test && pnpm --filter @brainstrike/pipeline test && pnpm --filter @brainstrike/file-import test',
    budgetMs: 240_000,
    owner: 'indexing',
    requiredFor: ['indexing-import-embedding'],
  },
  'embedding-tests': {
    name: 'embedding-tests',
    command:
      'pnpm --filter @brainstrike/embeddings test && pnpm --filter @brainstrike/embedding-worker test',
    budgetMs: 300_000,
    owner: 'indexing',
    requiredFor: ['indexing-import-embedding'],
  },
  'db-tests': {
    name: 'db-tests',
    command: 'pnpm --filter @brainstrike/db test',
    budgetMs: 300_000,
    owner: 'data-platform',
    requiredFor: ['db-migrations-storage'],
  },
  'storage-tests': {
    name: 'storage-tests',
    command: 'pnpm --filter @brainstrike/storage test',
    budgetMs: 120_000,
    owner: 'data-platform',
    requiredFor: ['db-migrations-storage'],
  },
  'file-system-tests': {
    name: 'file-system-tests',
    command: 'pnpm --filter @brainstrike/file-system test',
    budgetMs: 120_000,
    owner: 'data-platform',
    requiredFor: ['db-migrations-storage'],
  },
  'migration-tests': {
    name: 'migration-tests',
    command:
      'pnpm --filter @brainstrike/db exec vitest run __tests__/migration-integration.test.ts __tests__/migration-runner.test.ts __tests__/drizzle-migrate.test.ts',
    budgetMs: 180_000,
    owner: 'data-platform',
    requiredFor: ['db-migrations-storage'],
  },
  'desktop-unit-tests': {
    name: 'desktop-unit-tests',
    command: 'pnpm --filter @brainstrike/desktop test',
    budgetMs: 240_000,
    owner: 'desktop-platform',
    requiredFor: ['desktop-platform-ipc-preload'],
  },
  'desktop-smoke-tests': {
    name: 'desktop-smoke-tests',
    command:
      'pnpm --filter @brainstrike/desktop exec playwright test e2e/assistant-panel.desktop.test.ts e2e/background-indexing-pause.desktop.test.ts e2e/file-system.test.ts --project=smoke',
    budgetMs: 300_000,
    owner: 'desktop-platform',
    requiredFor: ['desktop-platform-ipc-preload'],
  },
  'desktop-embedding-smoke': {
    name: 'desktop-embedding-smoke',
    command:
      'pnpm --filter @brainstrike/desktop exec playwright test e2e/embedding-worker-renderer.smoke.desktop.test.ts --project=regression --grep "@desktop-embedding-lifecycle"',
    budgetMs: 420_000,
    owner: 'indexing',
    requiredFor: ['desktop-platform-ipc-preload'],
  },
  'desktop-llm-host-smoke': {
    name: 'desktop-llm-host-smoke',
    command:
      'pnpm --filter @brainstrike/desktop exec playwright test e2e/llm-host-renderer.test.ts --project=regression --grep "@desktop-llm-host-recovery"',
    budgetMs: 300_000,
    owner: 'desktop-platform',
    requiredFor: ['desktop-platform-ipc-preload'],
  },
  'file-explorer-tests': {
    name: 'file-explorer-tests',
    command:
      'pnpm --filter @brainstrike/file-explorer-ui test && pnpm --filter @brainstrike/file-explorer test',
    budgetMs: 240_000,
    owner: 'workspace-experience',
    requiredFor: ['web-ui-file-explorer'],
  },
  'web-smoke-tests': {
    name: 'web-smoke-tests',
    command:
      'pnpm --filter @brainstrike/web exec playwright test --project=functional --grep "@smoke" --workers=2',
    budgetMs: 300_000,
    owner: 'applications',
    requiredFor: ['web-ui-file-explorer', 'assistant-contract-runtime'],
  },
  'shared-foundation-tests': {
    name: 'shared-foundation-tests',
    command:
      'pnpm --filter @brainstrike/types build && pnpm --filter @brainstrike/utils test && pnpm --filter @brainstrike/worker-runtime test',
    budgetMs: 180_000,
    owner: 'shared-foundation',
    requiredFor: ['shared-foundation'],
  },
  'full-local-suite': {
    name: 'full-local-suite',
    command:
      'pnpm build && pnpm lint:ci && pnpm type-check && pnpm test && pnpm test:e2e',
    budgetMs: 45 * 60_000,
    owner: 'release',
    requiredFor: ['full-release-high-risk'],
  },
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

function resolveBudgetTarget(riskProfile) {
  if (riskProfile.category === 'docs-only') {
    return { target: 'fast-local', targetMs: 2 * 60_000 };
  }
  if (riskProfile.category === 'full-release-high-risk') {
    return { target: 'release-full-risk', targetMs: 60 * 60_000 };
  }
  if (riskProfile.e2eLanes.length === 0) {
    return { target: 'local-pr-risk', targetMs: 8 * 60_000 };
  }
  return { target: 'normal-pr-risk', targetMs: 15 * 60_000 };
}

function summarizeBudget(riskProfile, commands) {
  const totalMs = commands.reduce((sum, command) => sum + command.budgetMs, 0);
  const { target, targetMs } = resolveBudgetTarget(riskProfile);
  return {
    target,
    targetMs,
    totalMs,
    status: totalMs <= targetMs ? 'within-target' : 'over-target',
  };
}

export function buildSelection(input) {
  if (!/^[0-9a-f]{40}$/i.test(input.mergeBase)) {
    throw new Error(`mergeBase must be a 40-character git SHA: ${input.mergeBase}`);
  }
  const riskProfile = selectRiskProfileForFiles(input.files);
  const lanes = selectRiskLanesForFiles(input.files);
  const expandedLanes = expandRiskLanes(lanes);
  const labels = toRiskLabels(lanes);
  const commands = riskProfile.proofCommands.map((commandName) => {
    const command = LOCAL_PROOF_COMMANDS[commandName];
    if (!command) {
      throw new Error(`no local proof command defined for ${commandName}`);
    }
    return renderCommand(command, input.mergeBase);
  });
  const budget = summarizeBudget(riskProfile, commands);

  return {
    base: input.base,
    baseSha: input.baseSha,
    head: input.head,
    headSha: input.headSha,
    mergeBase: input.mergeBase,
    files: [...input.files],
    riskProfile,
    lanes,
    expandedLanes,
    labels,
    commands,
    budget,
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
      riskProfile: selection.riskProfile ?? null,
      lanes: selection.lanes,
      expandedLanes: selection.expandedLanes,
      labels: selection.labels,
      commands: selection.commands,
      budget: selection.budget ?? null,
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
