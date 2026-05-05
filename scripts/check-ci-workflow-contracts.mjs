#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const workflowPath = path.join(rootDir, '.github/workflows/test.yml');
const setupMonorepoActionPath = path.join(rootDir, '.github/actions/setup-monorepo/action.yml');
const setupDesktopE2EActionPath = path.join(rootDir, '.github/actions/setup-desktop-e2e/action.yml');
const desktopPlaywrightConfigPath = path.join(rootDir, 'apps/desktop/playwright.config.ts');
const playwrightEnvironmentPath = path.join(rootDir, 'packages/config/src/playwright-environment.ts');

function extractBlock(source, startPattern, nextPattern) {
  const start = source.search(startPattern);
  if (start === -1) {
    return null;
  }

  const rest = source.slice(start);
  const next = rest.search(nextPattern);
  return next === -1 ? rest : rest.slice(0, next);
}

export function extractJob(source, jobName) {
  return extractBlock(source, new RegExp(`^  ${escapeRegExp(jobName)}:\\s*$`, 'm'), /\n  [a-zA-Z0-9_.-]+:\s*$/m);
}

function requireMatch(source, pattern, message, failures) {
  if (!pattern.test(source)) {
    failures.push(message);
  }
}

function requireIncludes(source, text, message, failures) {
  if (!source.includes(text)) {
    failures.push(message);
  }
}

function requireNotIncludes(source, text, message, failures) {
  if (source.includes(text)) {
    failures.push(message);
  }
}

function requireNumericMatchAtMost(source, pattern, maxValue, message, failures) {
  const match = source.match(pattern);
  const value = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;
  if (!Number.isFinite(value) || value > maxValue) {
    failures.push(message);
  }
}

function requireNumericCliFlagAtMost(source, flag, maxValue, message, failures) {
  requireNumericMatchAtMost(
    source,
    new RegExp(`${escapeRegExp(flag)}=(\\d+)`),
    maxValue,
    message,
    failures
  );
}

function extractJobHeader(source) {
  const stepsStart = source.search(/^\s+steps:\s*$/m);
  return stepsStart === -1 ? source : source.slice(0, stepsStart);
}

function escapeRegExp(source) {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function requireYamlListItem(source, item, message, failures) {
  requireMatch(source, new RegExp(`^\\s+- ${escapeRegExp(item)}\\s*$`, 'm'), message, failures);
}

function extractTurboRunCommandLines(source) {
  return source.split('\n').filter((line) => /\bturbo\s+run\b/.test(line));
}

function requireEveryTurboCommandHas(source, text, message, failures) {
  const commandLines = extractTurboRunCommandLines(source);
  if (commandLines.length === 0) {
    failures.push(`${message} No Turbo run commands were found.`);
    return;
  }

  for (const line of commandLines) {
    if (!line.includes(text)) {
      failures.push(`${message} Offending command: ${line.trim()}`);
    }
  }
}

function requireDesktopEmbeddingJobContracts(source, prefix, failures) {
  requireIncludes(
    source,
    'image: mcr.microsoft.com/playwright:v1.59.1-noble',
    `${prefix} desktop embedding job must run in the preprovisioned Playwright Noble image.`,
    failures
  );
  requireNotIncludes(
    source,
    'apt-get',
    `${prefix} desktop embedding job must not run apt-get in the required shard path.`,
    failures
  );
  requireNotIncludes(
    source,
    'sudo ',
    `${prefix} desktop embedding job must not require sudo in the required shard path.`,
    failures
  );
  requireIncludes(
    source,
    'timeout-minutes: 15',
    `${prefix} desktop embedding job timeout must stay at 15 minutes or less.`,
    failures
  );
  requireMatch(
    source,
    /- name: Run Desktop embedding E2E regression group[\s\S]*?timeout-minutes:\s*12/,
    `${prefix} desktop embedding test step timeout must stay at 12 minutes or less.`,
    failures
  );
  requireIncludes(
    source,
    '--retries=0',
    `${prefix} desktop embedding E2E must disable Playwright retries.`,
    failures
  );
  requireIncludes(
    source,
    '--max-failures=1',
    `${prefix} desktop embedding E2E must fail fast on the first failure.`,
    failures
  );
  requireIncludes(
    source,
    '--global-timeout=720000',
    `${prefix} desktop embedding E2E must cap Playwright runtime at 12 minutes.`,
    failures
  );
  if (source.includes('@desktop-embedding-core')) {
    failures.push(
      `${prefix} desktop embedding E2E must not reintroduce the broad @desktop-embedding-core lane.`
    );
  }
  for (const diagnosticGroup of [
    '@desktop-embedding-crash-a',
    '@desktop-embedding-crash-b',
  ]) {
    if (source.includes(diagnosticGroup)) {
      failures.push(
        `${prefix} desktop embedding E2E must keep diagnostic ${diagnosticGroup} out of required lanes.`
      );
    }
  }
}

function requireDesktopRegressionJobContracts(source, prefix, failures) {
  requireIncludes(
    source,
    'image: mcr.microsoft.com/playwright:v1.59.1-noble',
    `${prefix} desktop regression job must run in the preprovisioned Playwright Noble image.`,
    failures
  );
  requireNotIncludes(
    source,
    'apt-get',
    `${prefix} desktop regression job must not run apt-get in the required shard path.`,
    failures
  );
  requireNotIncludes(
    source,
    'sudo ',
    `${prefix} desktop regression job must not require sudo in the required shard path.`,
    failures
  );
  requireNumericMatchAtMost(
    extractJobHeader(source),
    /^    timeout-minutes:\s*(\d+)\s*$/m,
    20,
    `${prefix} desktop regression job timeout must stay at 20 minutes or less.`,
    failures
  );

  const regressionStep = requireSingleNamedStep(
    source,
    /Run Desktop E2E (?:regression )?tests \(shard\)/,
    `${prefix} desktop regression test step`,
    failures
  );
  if (!regressionStep) {
    return;
  }

  requireNumericMatchAtMost(
    regressionStep,
    /^\s+timeout-minutes:\s*(\d+)\s*$/m,
    15,
    `${prefix} desktop regression test step timeout must stay at 15 minutes or less.`,
    failures
  );
  for (const [flag, message] of [
    ['--retries=0', `${prefix} desktop regression E2E must disable Playwright retries.`],
    ['--max-failures=1', `${prefix} desktop regression E2E must fail fast on the first failure.`],
  ]) {
    requireIncludes(regressionStep, flag, message, failures);
  }
  requireNumericCliFlagAtMost(
    regressionStep,
    '--global-timeout',
    720_000,
    `${prefix} desktop regression E2E must cap Playwright runtime at 12 minutes.`,
    failures
  );
}

function requirePreprovisionedPlaywrightJobContracts(source, prefix, failures) {
  requireIncludes(
    source,
    'image: mcr.microsoft.com/playwright:v1.59.1-noble',
    `${prefix} Playwright job must run in the preprovisioned Playwright Noble image.`,
    failures
  );
  requireIncludes(
    source,
    'PLAYWRIGHT_BROWSERS_PATH: /ms-playwright',
    `${prefix} Playwright job must use the image-provided browser path explicitly.`,
    failures
  );
  requireNotIncludes(
    source,
    'pnpm exec playwright install',
    `${prefix} Playwright job must not install browsers or browser system dependencies during required CI.`,
    failures
  );
  requireNotIncludes(
    source,
    'install-deps',
    `${prefix} Playwright job must not run install-deps during required CI.`,
    failures
  );
  requireNotIncludes(
    source,
    'apt-get',
    `${prefix} Playwright job must not run apt-get during required CI.`,
    failures
  );

  const verifyStep = requireSingleNamedStep(
    source,
    /Verify preprovisioned Playwright runtime/,
    `${prefix} preprovisioned Playwright runtime verification step`,
    failures
  );

  if (verifyStep) {
    requireIncludes(
      verifyStep,
      'test -d "$PLAYWRIGHT_BROWSERS_PATH"',
      `${prefix} Playwright job must fail fast if the image browser path is missing.`,
      failures
    );
    requireIncludes(
      verifyStep,
      "require('playwright')",
      `${prefix} Playwright job must verify the project Playwright package.`,
      failures
    );
    requireIncludes(
      verifyStep,
      'chromium.launch',
      `${prefix} Playwright job must prove Chromium launches before running the test lane.`,
      failures
    );
  }
}

function extractNamedStepBlocks(source, namePattern) {
  const lines = source.split('\n');
  const blocks = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^\s+- name:\s*/.test(line) || !namePattern.test(line)) {
      continue;
    }

    const blockLines = [line];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^\s+- name:\s*/.test(lines[cursor])) {
        break;
      }
      blockLines.push(lines[cursor]);
    }
    blocks.push(blockLines.join('\n'));
  }

  return blocks;
}

function requireSingleNamedStep(source, namePattern, description, failures) {
  const blocks = extractNamedStepBlocks(source, namePattern);
  if (blocks.length !== 1) {
    failures.push(`${description} must appear exactly once.`);
    return null;
  }

  return blocks[0];
}

export function validateWorkflowContracts(source) {
  const failures = [];

  requireMatch(
    source,
    /concurrency:[\s\S]*cancel-in-progress:\s*\$\{\{\s*github\.event_name == 'pull_request'\s*\}\}/,
    'Test workflow must cancel superseded pull_request runs.',
    failures
  );
  requireEveryTurboCommandHas(
    source,
    '--cache-dir=.turbo',
    'Turbo commands in the Test workflow must use the shared .turbo cache directory.',
    failures
  );
  requireEveryTurboCommandHas(
    source,
    '--summarize',
    'Turbo commands in the Test workflow must emit run summaries for diagnostics.',
    failures
  );
  requireEveryTurboCommandHas(
    source,
    '--log-order=grouped',
    'Turbo commands in the Test workflow must keep grouped logs for readable failure triage.',
    failures
  );

  // Shard count is intentionally enforced in the workflow and this lint so CI
  // wall-time/cost changes are reviewed as explicit contract changes.
  const determineMatrix = extractJob(source, 'determine-matrix');
  if (!determineMatrix) {
    failures.push('Missing determine-matrix job.');
  } else {
    requireIncludes(
      determineMatrix,
      'web-shards=["1","2","3","4","5"]',
      'Functional web E2E matrix must stay at five shards.',
      failures
    );
    requireIncludes(
      determineMatrix,
      'web-shard-total=["5"]',
      'Functional web E2E shard total must stay at five.',
      failures
    );
    requireIncludes(
      determineMatrix,
      'desktop-shards=["1","2","3","4"]',
      'Desktop regression matrix must stay at four shards on PRs and main.',
      failures
    );
    requireIncludes(
      determineMatrix,
      'desktop-shard-total=["4"]',
      'Desktop regression shard total must stay at four on PRs and main.',
      failures
    );
  }

  const e2e = extractJob(source, 'e2e');
  if (!e2e) {
    failures.push('Missing e2e job.');
  } else {
    requirePreprovisionedPlaywrightJobContracts(e2e, 'Functional E2E', failures);
    requireIncludes(
      e2e,
      'needs: [checks, determine-matrix]',
      'Functional E2E must depend on checks and determine-matrix.',
      failures
    );
    requireIncludes(
      e2e,
      '--workers=2',
      'Functional E2E must keep two workers per shard.',
      failures
    );
    requireIncludes(
      e2e,
      '--grep-invert "@destructive|@stateful"',
      'Functional E2E must exclude isolated @destructive and @stateful specs.',
      failures
    );
    requireIncludes(
      e2e,
      '--shard=${{ matrix.shardIndex }}/${{ matrix.shardTotal }}',
      'Functional E2E must run the configured shard.',
      failures
    );
  }

  const stateful = extractJob(source, 'e2e-stateful');
  if (!stateful) {
    failures.push('Missing e2e-stateful job.');
  } else {
    requirePreprovisionedPlaywrightJobContracts(stateful, 'Stateful E2E', failures);
    requireIncludes(
      stateful,
      'needs: [checks]',
      'Stateful E2E must not wait on determine-matrix.',
      failures
    );
    requireIncludes(
      stateful,
      '--workers=1 --grep "@stateful"',
      'Stateful E2E must run tagged specs in a one-worker lane.',
      failures
    );
  }

  const destructive = extractJob(source, 'e2e-destructive');
  if (!destructive) {
    failures.push('Missing e2e-destructive job.');
  } else {
    requirePreprovisionedPlaywrightJobContracts(destructive, 'Destructive E2E', failures);
    requireIncludes(
      destructive,
      'needs: [checks]',
      'Destructive E2E must not wait on determine-matrix.',
      failures
    );
    requireIncludes(
      destructive,
      '--workers=1',
      'Destructive E2E must run tagged specs in a one-worker lane.',
      failures
    );
    requireIncludes(
      destructive,
      '--retries=0',
      'Destructive E2E must disable Playwright retries.',
      failures
    );
    requireIncludes(
      destructive,
      '--max-failures=1',
      'Destructive E2E must fail fast on the first failure.',
      failures
    );
    requireIncludes(
      destructive,
      '--global-timeout=600000',
      'Destructive E2E must keep the Playwright global timeout at ten minutes.',
      failures
    );
    requireIncludes(
      destructive,
      '--grep "@destructive"',
      'Destructive E2E must run tagged specs in the destructive lane.',
      failures
    );
  }

  const desktopPr = extractJob(source, 'desktop-e2e-pr');
  if (!desktopPr) {
    failures.push('Missing desktop-e2e-pr job.');
  } else {
    requireIncludes(
      desktopPr,
      'name: Desktop E2E Regression',
      'PR desktop E2E status must prove the desktop regression suite.',
      failures
    );
    requireIncludes(
      desktopPr,
      "if: github.event_name == 'pull_request'",
      'PR desktop regression job must run on pull_request.',
      failures
    );
    requireIncludes(
      desktopPr,
      '--project=regression',
      'PR desktop E2E must run the regression Playwright project.',
      failures
    );
    requireIncludes(
      desktopPr,
      '--grep-invert "@desktop-embedding-"',
      'PR desktop E2E shard job must exclude embedding groups covered by the embedding job.',
      failures
    );
    requireIncludes(
      desktopPr,
      '--workers=2',
      'PR desktop E2E must keep two workers per shard.',
      failures
    );
    requireDesktopRegressionJobContracts(desktopPr, 'PR', failures);
    if (desktopPr.includes('--project=smoke')) {
      failures.push('PR desktop E2E must not use smoke as the required desktop proof.');
    }
  }

  const desktopEmbeddingPr = extractJob(source, 'desktop-e2e-embedding-pr');
  if (!desktopEmbeddingPr) {
    failures.push('Missing desktop-e2e-embedding-pr job.');
  } else {
    requireIncludes(
      desktopEmbeddingPr,
      'name: Desktop E2E Embedding Regression',
      'PR desktop embedding E2E status must prove embedding regressions.',
      failures
    );
    requireIncludes(
      desktopEmbeddingPr,
      "if: github.event_name == 'pull_request'",
      'PR desktop embedding regression job must run on pull_request.',
      failures
    );
    for (const group of [
      '@desktop-embedding-lifecycle',
      '@desktop-embedding-backfill',
      '@desktop-embedding-search',
      '@desktop-embedding-recovery',
      '@desktop-embedding-memory',
      '@desktop-embedding-mixed',
    ]) {
      requireIncludes(
        desktopEmbeddingPr,
        group,
        `PR desktop embedding E2E must include ${group}.`,
        failures
      );
    }
    requireDesktopEmbeddingJobContracts(desktopEmbeddingPr, 'PR', failures);
  }

  const desktopMain = extractJob(source, 'desktop-e2e-main');
  if (!desktopMain) {
    failures.push('Missing desktop-e2e-main job.');
  } else {
    requireIncludes(
      desktopMain,
      'name: Desktop E2E Regression',
      'Main desktop E2E status must prove the desktop regression suite.',
      failures
    );
    requireIncludes(
      desktopMain,
      "if: github.event_name != 'pull_request'",
      'Main desktop regression job must run after merge/push.',
      failures
    );
    requireIncludes(
      desktopMain,
      '--project=regression',
      'Main desktop E2E must run the regression Playwright project.',
      failures
    );
    requireIncludes(
      desktopMain,
      '--grep-invert "@desktop-embedding-"',
      'Main desktop E2E shard job must exclude embedding groups covered by the embedding job.',
      failures
    );
    requireIncludes(
      desktopMain,
      '--workers=2',
      'Main desktop E2E must keep two workers per shard.',
      failures
    );
    requireDesktopRegressionJobContracts(desktopMain, 'Main', failures);
  }

  const desktopEmbeddingMain = extractJob(source, 'desktop-e2e-embedding-main');
  if (!desktopEmbeddingMain) {
    failures.push('Missing desktop-e2e-embedding-main job.');
  } else {
    requireIncludes(
      desktopEmbeddingMain,
      'name: Desktop E2E Embedding Regression',
      'Main desktop embedding E2E status must prove embedding regressions.',
      failures
    );
    requireIncludes(
      desktopEmbeddingMain,
      "if: github.event_name != 'pull_request'",
      'Main desktop embedding regression job must run after merge/push.',
      failures
    );
    for (const group of [
      '@desktop-embedding-lifecycle',
      '@desktop-embedding-backfill',
      '@desktop-embedding-search',
      '@desktop-embedding-recovery',
      '@desktop-embedding-memory',
      '@desktop-embedding-mixed',
    ]) {
      requireIncludes(
        desktopEmbeddingMain,
        group,
        `Main desktop embedding E2E must include ${group}.`,
        failures
      );
    }
    requireDesktopEmbeddingJobContracts(desktopEmbeddingMain, 'Main', failures);
  }

  const unitCoverage = extractJob(source, 'unit_coverage');
  if (!unitCoverage) {
    failures.push('Missing unit_coverage job.');
  } else {
    requireIncludes(
      unitCoverage,
      'timeout-minutes: 45',
      'Unit coverage job timeout must stay at 45 minutes or less.',
      failures
    );
    requireIncludes(
      unitCoverage,
      'timeout-minutes: 30',
      'Unit coverage test step timeout must stay at 30 minutes or less.',
      failures
    );
    requireIncludes(
      unitCoverage,
      '--filter="!@brainstrike/db"',
      'Unit coverage must exclude the monolithic @brainstrike/db coverage task.',
      failures
    );
    requireIncludes(
      unitCoverage,
      '$DB_COVERAGE_TASKS --filter="@brainstrike/db"',
      'Split DB coverage tasks must be constrained to @brainstrike/db.',
      failures
    );
    requireIncludes(
      unitCoverage,
      '$DB_COVERAGE_TASKS --filter="@brainstrike/db" --concurrency=1',
      'Split DB coverage lanes must run serially to avoid PGlite runner contention.',
      failures
    );
    requireNotIncludes(
      unitCoverage,
      '$DB_COVERAGE_TASKS --filter="@brainstrike/db" --concurrency=4',
      'Split DB coverage lanes must not run with concurrency 4 on GitHub runners.',
      failures
    );
    requireIncludes(
      unitCoverage,
      '$DB_COVERAGE_RUNTIME_TASK --filter="@brainstrike/db" --concurrency=1',
      'DB runtime coverage must run alone to avoid PGlite cold-start resource contention.',
      failures
    );
    for (const taskName of [
      'test:coverage:db:architecture',
      'test:coverage:db:chunking',
      'test:coverage:db:migrations',
      'test:coverage:db:queue',
      'test:coverage:db:repositories',
      'test:coverage:db:runtime',
      'test:coverage:db:search',
    ]) {
      requireIncludes(
        unitCoverage,
        taskName,
        `Unit coverage must run split DB coverage task ${taskName}.`,
        failures
      );
    }
    requireIncludes(
      unitCoverage,
      'pnpm coverage:prepare-workspace',
      'Unit coverage must merge split workspace coverage before threshold enforcement.',
      failures
    );
    requireIncludes(
      unitCoverage,
      '--task-prefix test:coverage',
      'Unit coverage timing diagnostics must include split coverage tasks.',
      failures
    );
    requireIncludes(
      unitCoverage,
      '--warn-ms 600000 --fail-ms 900000',
      'Unit coverage package task timing thresholds must stay capped at 10m warn / 15m fail.',
      failures
    );
  }

  const browserTests = extractJob(source, 'browser-tests');
  if (!browserTests) {
    failures.push('Missing browser-tests job.');
  } else {
    requirePreprovisionedPlaywrightJobContracts(browserTests, 'Browser Vitest', failures);
  }

  const requiredPrGate = extractJob(source, 'required-pr-gate');
  if (!requiredPrGate) {
    failures.push('Missing required-pr-gate job.');
  } else {
    requireIncludes(
      requiredPrGate,
      'name: Required PR Gate',
      'Required PR Gate status name must stay stable for branch rulesets.',
      failures
    );
    for (const jobName of [
      'checks',
      'unit_coverage',
      'browser-tests',
      'prepare-web',
      'prepare-desktop',
      'e2e',
      'e2e-stateful',
      'e2e-destructive',
      'desktop-e2e-pr',
      'desktop-e2e-embedding-pr',
      'merge-reports',
    ]) {
      requireYamlListItem(
        requiredPrGate,
        jobName,
        `Required PR Gate must depend on ${jobName}.`,
        failures
      );
    }
    requireIncludes(
      requiredPrGate,
      "job.result !== 'success'",
      'Required PR Gate must fail unless every dependency succeeds.',
      failures
    );
  }

  const requiredMainGate = extractJob(source, 'required-main-gate');
  if (!requiredMainGate) {
    failures.push('Missing required-main-gate job.');
  } else {
    requireIncludes(
      requiredMainGate,
      'name: Required Main Gate',
      'Required Main Gate status name must stay stable for branch rulesets.',
      failures
    );
    for (const jobName of [
      'checks',
      'unit_coverage',
      'browser-tests',
      'prepare-web',
      'prepare-desktop',
      'e2e',
      'e2e-stateful',
      'e2e-destructive',
      'desktop-e2e-main',
      'desktop-e2e-embedding-main',
      'merge-reports',
    ]) {
      requireYamlListItem(
        requiredMainGate,
        jobName,
        `Required Main Gate must depend on ${jobName}.`,
        failures
      );
    }
    requireIncludes(
      requiredMainGate,
      "job.result !== 'success'",
      'Required Main Gate must fail unless every dependency succeeds.',
      failures
    );
  }

  const blobUploadBlocks = extractNamedStepBlocks(source, /Upload .*blob report/i);
  if (blobUploadBlocks.length === 0) {
    failures.push('Missing Playwright blob report upload steps.');
  }
  for (const block of blobUploadBlocks) {
    requireIncludes(block, 'if: failure()', 'Blob report uploads must be failure-only.', failures);
    requireIncludes(block, 'retention-days: 1', 'Blob report uploads must retain for one day.', failures);
  }

  return failures;
}

export function validateSetupMonorepoContracts(source) {
  const failures = [];
  const turboCacheStep = requireSingleNamedStep(
    source,
    /Cache Turborepo/,
    'Setup monorepo Turbo cache step',
    failures
  );

  if (turboCacheStep) {
    requireIncludes(
      turboCacheStep,
      'id: turbo-cache',
      'Setup monorepo Turborepo cache step must expose cache-hit output.',
      failures
    );
    requireIncludes(
      turboCacheStep,
      'uses: actions/cache@v5',
      'Setup monorepo must use actions/cache for the Turborepo local cache.',
      failures
    );
    requireMatch(
      turboCacheStep,
      /^\s+path:\s*\.turbo\s*$/m,
      'Setup monorepo must cache the shared .turbo directory.',
      failures
    );
    requireIncludes(
      turboCacheStep,
      "hashFiles('**/pnpm-lock.yaml', 'turbo.jsonc', '**/tsconfig*.json')",
      'Setup monorepo Turborepo cache key must include lockfile, turbo config, and tsconfig inputs.',
      failures
    );
    requireIncludes(
      turboCacheStep,
      '${{ runner.os }}-node22-turbo-v4-',
      'Setup monorepo Turborepo cache must keep the stable node22 restore prefix.',
      failures
    );
  }

  const pnpmStoreCacheStep = requireSingleNamedStep(
    source,
    /Cache pnpm store/,
    'Setup monorepo pnpm store cache step',
    failures
  );
  if (pnpmStoreCacheStep) {
    requireIncludes(
      pnpmStoreCacheStep,
      'id: pnpm-store-cache',
      'Setup monorepo pnpm store cache step must expose cache-hit output.',
      failures
    );
  }

  const cacheStatusStep = requireSingleNamedStep(
    source,
    /Report setup cache status/,
    'Setup monorepo cache status summary step',
    failures
  );
  if (cacheStatusStep) {
    requireIncludes(
      cacheStatusStep,
      'PNPM_CACHE_HIT: ${{ steps.pnpm-store-cache.outputs.cache-hit }}',
      'Setup monorepo cache summary must report pnpm cache hit status.',
      failures
    );
    requireIncludes(
      cacheStatusStep,
      'TURBO_CACHE_HIT: ${{ steps.turbo-cache.outputs.cache-hit }}',
      'Setup monorepo cache summary must report Turborepo cache hit status.',
      failures
    );
    requireIncludes(
      cacheStatusStep,
      '$GITHUB_STEP_SUMMARY',
      'Setup monorepo cache summary must write to the GitHub step summary.',
      failures
    );
  }

  return failures;
}

export function validateSetupDesktopE2EContracts(source) {
  const failures = [];
  requireNotIncludes(
    source,
    'pnpm exec playwright install-deps',
    'Setup desktop E2E must not run Playwright install-deps inside every desktop shard.',
    failures
  );
  requireNotIncludes(
    source,
    'apt-get',
    'Setup desktop E2E must not run apt-get inside every desktop shard.',
    failures
  );
  requireNotIncludes(
    source,
    'sudo ',
    'Setup desktop E2E must not require sudo inside every desktop shard.',
    failures
  );

  const systemDepsStep = requireSingleNamedStep(
    source,
    /Verify preprovisioned Electron runtime dependencies/,
    'Setup desktop E2E preprovisioned dependency verification step',
    failures
  );

  if (systemDepsStep) {
    requireIncludes(
      systemDepsStep,
      'command -v Xvfb >/dev/null',
      'Setup desktop E2E must verify Xvfb is already present in the CI image.',
      failures
    );
    requireIncludes(
      systemDepsStep,
      'cd apps/desktop',
      'Setup desktop E2E must resolve Electron from the desktop package under pnpm.',
      failures
    );
    requireIncludes(
      systemDepsStep,
      'ELECTRON_BINARY="$(node -p "require(\'electron\')")"',
      'Setup desktop E2E must resolve the installed Electron binary before runtime dependency checks.',
      failures
    );
    requireIncludes(
      systemDepsStep,
      'ldd "${ELECTRON_BINARY}"',
      'Setup desktop E2E must inspect Electron shared-library dependencies without network installation.',
      failures
    );
    requireIncludes(
      systemDepsStep,
      'grep -q "not found"',
      'Setup desktop E2E must fail fast when the CI image is missing Electron runtime dependencies.',
      failures
    );
  }

  return failures;
}

export function validateDesktopE2EContracts({
  playwrightConfigSource,
  playwrightEnvironmentSource,
}) {
  const failures = [];

  requireIncludes(
    playwrightConfigSource,
    'workers: config.workers',
    'Desktop Playwright config must not force workers to one.',
    failures
  );
  requireIncludes(
    playwrightConfigSource,
    'fullyParallel: config.fullyParallel',
    'Desktop Playwright config must use shared parallelism policy.',
    failures
  );
  requireIncludes(
    playwrightEnvironmentSource,
    'return 0;',
    'Playwright environment config must keep globalTimeout disabled.',
    failures
  );
  if (playwrightEnvironmentSource.includes('15 * 60 * 1000')) {
    failures.push('Playwright environment config must not use a 15 minute global timeout.');
  }

  return failures;
}

export async function main() {
  const [
    source,
    setupMonorepoActionSource,
    setupDesktopE2EActionSource,
    desktopPlaywrightConfigSource,
    playwrightEnvironmentSource,
  ] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(setupMonorepoActionPath, 'utf8'),
    readFile(setupDesktopE2EActionPath, 'utf8'),
    readFile(desktopPlaywrightConfigPath, 'utf8'),
    readFile(playwrightEnvironmentPath, 'utf8'),
  ]);
  const failures = [
    ...validateWorkflowContracts(source),
    ...validateSetupMonorepoContracts(setupMonorepoActionSource),
    ...validateSetupDesktopE2EContracts(setupDesktopE2EActionSource),
    ...validateDesktopE2EContracts({
      playwrightConfigSource: desktopPlaywrightConfigSource,
      playwrightEnvironmentSource,
    }),
  ];

  if (failures.length > 0) {
    console.error('CI workflow contract check failed.');
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log('CI workflow contract check passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
