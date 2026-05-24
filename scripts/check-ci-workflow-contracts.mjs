#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const workflowPath = path.join(rootDir, '.github/workflows/test.yml');
const claudeReviewWorkflowPath = path.join(rootDir, '.github/workflows/claude-code-review.yml');
const setupMonorepoActionPath = path.join(rootDir, '.github/actions/setup-monorepo/action.yml');
const setupDesktopE2EActionPath = path.join(rootDir, '.github/actions/setup-desktop-e2e/action.yml');
const turboConfigPath = path.join(rootDir, 'turbo.jsonc');
const desktopPlaywrightConfigPath = path.join(rootDir, 'apps/desktop/playwright.config.ts');
const playwrightEnvironmentPath = path.join(rootDir, 'packages/config/src/playwright-environment.ts');
const MANUAL_FULL_RELEASE_EXPR =
  "github.event_name == 'workflow_dispatch' && inputs.release_proof == 'full-release'";
const MANUAL_BACKGROUNDING_EXPR =
  "github.event_name == 'workflow_dispatch' && inputs.release_proof == 'desktop-backgrounding'";

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

function requireNumericMatchAtLeast(source, pattern, minValue, message, failures) {
  const match = source.match(pattern);
  const value = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;
  if (!Number.isFinite(value) || value < minValue) {
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

function extractTopLevelBlock(source, key) {
  const lines = source.split('\n');
  const startIndex = lines.findIndex((line) => line === `${key}:`);
  if (startIndex === -1) {
    return null;
  }

  const block = [lines[startIndex]];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S/.test(line)) {
      break;
    }
    block.push(line);
  }

  return block.join('\n');
}

function extractWorkflowStep(source, stepName) {
  return extractBlock(
    source,
    new RegExp(`^      - name: ${escapeRegExp(stepName)}\\s*$`, 'm'),
    /\n      - name: .+$/m
  );
}

function requireStepTimeoutAtMost(source, stepName, maxValue, message, failures) {
  const step = extractWorkflowStep(source, stepName);
  if (!step) {
    failures.push(message);
    return;
  }

  requireNumericMatchAtMost(
    step,
    /^        timeout-minutes:\s*(\d+)\s*$/m,
    maxValue,
    message,
    failures
  );
}

function requireStepTimeoutAtLeast(source, stepName, minValue, message, failures) {
  const step = extractWorkflowStep(source, stepName);
  if (!step) {
    failures.push(message);
    return;
  }

  requireNumericMatchAtLeast(
    step,
    /^        timeout-minutes:\s*(\d+)\s*$/m,
    minValue,
    message,
    failures
  );
}

function escapeRegExp(source) {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractJsonObjectBlock(source, key) {
  const keyIndex = source.indexOf(`"${key}"`);
  if (keyIndex === -1) {
    return null;
  }

  const objectStart = source.indexOf('{', keyIndex);
  if (objectStart === -1) {
    return null;
  }

  let depth = 0;
  for (let index = objectStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(keyIndex, index + 1);
      }
    }
  }

  return null;
}

export function validateClaudeReviewWorkflowContracts(source) {
  const failures = [];
  const reviewJob = extractJob(source, 'review');
  if (!reviewJob) {
    failures.push('Claude auto-review workflow must define a review job.');
    return failures;
  }

  requireNumericMatchAtLeast(
    extractJobHeader(reviewJob),
    /^    timeout-minutes:\s*(\d+)\s*$/m,
    60,
    'Claude auto-review timeout must allow large PR reviews.',
    failures
  );
  requireNumericMatchAtLeast(
    reviewJob,
    /--max-turns\s+(\d+)/,
    80,
    'Claude auto-review max-turns must allow large PR reviews.',
    failures
  );
  requireIncludes(
    reviewJob,
    'id-token: write',
    'Claude auto-review must keep OIDC id-token permission enabled.',
    failures
  );
  requireIncludes(
    reviewJob,
    'anthropics/claude-code-action@v1',
    'Claude auto-review must use the Claude Code action.',
    failures
  );
  const selfChangeStep = extractWorkflowStep(reviewJob, 'Detect Claude workflow self-change');
  if (!selfChangeStep) {
    failures.push('Claude auto-review must detect self-edits before invoking Claude.');
  } else {
    requireIncludes(
      selfChangeStep,
      'id: claude-workflow-change',
      'Claude auto-review self-edit detector must expose a stable step id.',
      failures
    );
    requireIncludes(
      selfChangeStep,
      '.github/workflows/claude-code-review.yml',
      'Claude auto-review self-edit detector must check the review workflow path.',
      failures
    );
    requireIncludes(
      selfChangeStep,
      'gh pr diff',
      'Claude auto-review self-edit detector must inspect PR changed files.',
      failures
    );
  }
  requireIncludes(
    reviewJob,
    "if: ${{ steps.claude-workflow-change.outputs.changed != 'true' }}",
    'Claude auto-review must skip Claude when this workflow changes.',
    failures
  );
  requireNotIncludes(
    reviewJob,
    'continue-on-error: true',
    'Claude auto-review must not continue-on-error.',
    failures
  );

  return failures;
}

function requireYamlListItem(source, item, message, failures) {
  requireMatch(source, new RegExp(`^\\s+- ${escapeRegExp(item)}\\s*$`, 'm'), message, failures);
}

function requireReleaseMatrixEvents(job, jobName, failures) {
  requireIncludes(
    job,
    "github.event_name == 'schedule'",
    `${jobName} must remain available for schedule release-matrix runs.`,
    failures
  );
  requireIncludes(
    job,
    MANUAL_FULL_RELEASE_EXPR,
    `${jobName} must require release_proof=full-release for manual release-matrix runs.`,
    failures
  );
  requireNotIncludes(
    job,
    "github.event_name == 'workflow_dispatch' ||",
    `${jobName} must not run on unconfirmed manual workflow_dispatch events.`,
    failures
  );
}

function requireNoMainPushEvent(job, jobName, failures) {
  requireNotIncludes(
    job,
    "github.event_name == 'push'",
    `${jobName} must not run the release matrix on plain main pushes.`,
    failures
  );
}

function requireMainPushEvent(job, jobName, failures) {
  requireIncludes(
    job,
    "github.event_name == 'push'",
    `${jobName} must remain available for the main push smoke gate.`,
    failures
  );
}

function requireRiskLabelIncludes(job, jobName, labels, failures) {
  requireIncludes(
    job,
    "contains(join(github.event.pull_request.labels.*.name, ','), 'ci:full')",
    `${jobName} must run on PRs labeled ci:full.`,
    failures
  );
  for (const label of labels) {
    requireIncludes(
      job,
      `contains(join(github.event.pull_request.labels.*.name, ','), '${label}')`,
      `${jobName} must run on PRs labeled ${label}.`,
      failures
    );
  }
}

function requireRiskLabelGate(job, jobName, labels, failures) {
  requireReleaseMatrixEvents(job, jobName, failures);
  requireRiskLabelIncludes(job, jobName, labels, failures);
}

function requireMainPushAndRiskLabelGate(job, jobName, labels, failures) {
  requireMainPushEvent(job, jobName, failures);
  requireRiskLabelGate(job, jobName, labels, failures);
}

function requirePrRiskLabelGate(job, jobName, labels, failures) {
  requireRiskLabelIncludes(job, jobName, labels, failures);
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
  requireNotIncludes(
    source,
    'e2e/embedding-worker-renderer.test.ts',
    `${prefix} desktop embedding E2E must target the split embedding specs, not the removed monolithic spec.`,
    failures
  );
  for (const splitSpec of [
    'e2e/embedding-worker-renderer.smoke.desktop.test.ts',
    'e2e/embedding-worker-renderer.backfill-search.desktop.test.ts',
    'e2e/embedding-worker-renderer.memory.desktop.test.ts',
    'e2e/embedding-worker-renderer.diagnostics.desktop.test.ts',
    'e2e/embedding-worker-renderer.crash-a.desktop.test.ts',
  ]) {
    requireIncludes(
      source,
      splitSpec,
      `${prefix} desktop embedding E2E must include split spec ${splitSpec}.`,
      failures
    );
  }
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

function requireDesktopNarrowJobContracts(
  source,
  { label, name, prefix, script },
  failures
) {
  requirePrRiskLabelGate(source, prefix, [label], failures);
  requireIncludes(
    source,
    `name: ${name}`,
    `${prefix} status name must stay stable.`,
    failures
  );
  requireIncludes(
    source,
    'needs: [prepare-desktop]',
    `${prefix} must depend on the prepared desktop artifact.`,
    failures
  );
  requireIncludes(
    source,
    'image: mcr.microsoft.com/playwright:v1.59.1-noble',
    `${prefix} must run in the preprovisioned Playwright Noble image.`,
    failures
  );
  requireIncludes(
    source,
    'uses: ./.github/actions/setup-desktop-e2e',
    `${prefix} must use the shared desktop E2E setup action.`,
    failures
  );
  requireNotIncludes(
    source,
    'apt-get',
    `${prefix} must not run apt-get in the required lane path.`,
    failures
  );
  requireNotIncludes(
    source,
    'sudo ',
    `${prefix} must not require sudo in the required lane path.`,
    failures
  );
  requireNumericMatchAtMost(
    extractJobHeader(source),
    /^    timeout-minutes:\s*(\d+)\s*$/m,
    10,
    `${prefix} job timeout must stay at 10 minutes or less.`,
    failures
  );
  const laneStep = requireSingleNamedStep(
    source,
    new RegExp(`Run ${escapeRegExp(name).replaceAll(' ', '\\s+')}`, 'i'),
    `${prefix} test step`,
    failures
  );
  if (laneStep) {
    requireNumericMatchAtMost(
      laneStep,
      /^\s+timeout-minutes:\s*(\d+)\s*$/m,
      8,
      `${prefix} test step timeout must stay at 8 minutes or less.`,
      failures
    );
  }
  requireIncludes(
    source,
    script,
    `${prefix} must run ${script}.`,
    failures
  );
}

function requireWebNarrowJobContracts(source, { label, name, prefix, script, stepName }, failures) {
  requirePrRiskLabelGate(source, prefix, [label], failures);
  requireIncludes(source, `name: ${name}`, `${prefix} status name must stay stable.`, failures);
  requireIncludes(
    source,
    'needs: [checks, prepare-web]',
    `${prefix} must depend on checks and the prepared web artifact.`,
    failures
  );
  requireIncludes(
    source,
    'image: mcr.microsoft.com/playwright:v1.59.1-noble',
    `${prefix} must run in the preprovisioned Playwright Noble image.`,
    failures
  );
  requireNotIncludes(
    source,
    'test:e2e:lane:full-regression',
    `${prefix} must not silently expand to full web regression.`,
    failures
  );
  requireNumericMatchAtMost(
    extractJobHeader(source),
    /^    timeout-minutes:\s*(\d+)\s*$/m,
    15,
    `${prefix} job timeout must stay at 15 minutes or less.`,
    failures
  );
  const laneStep = requireSingleNamedStep(
    source,
    new RegExp(escapeRegExp(stepName), 'i'),
    `${prefix} test step`,
    failures
  );
  if (laneStep) {
    requireNumericMatchAtMost(
      laneStep,
      /^\s+timeout-minutes:\s*(\d+)\s*$/m,
      12,
      `${prefix} test step timeout must stay at 12 minutes or less.`,
      failures
    );
  }
  requireIncludes(source, script, `${prefix} must run ${script}.`, failures);
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

function requireWorkflowSecurityContracts(source, failures) {
  const permissions = extractTopLevelBlock(source, 'permissions');
  if (!permissions) {
    failures.push('Test workflow must define explicit top-level permissions.');
    return;
  }

  for (const [permission, value] of [
    ['contents', 'read'],
    ['pull-requests', 'write'],
    ['security-events', 'write'],
  ]) {
    requireMatch(
      permissions,
      new RegExp(`^  ${escapeRegExp(permission)}:\\s*${escapeRegExp(value)}\\s*$`, 'm'),
      `Test workflow must keep ${permission}: ${value} permission.`,
      failures
    );
  }

  for (const widenedPermission of [
    'actions: write',
    'checks: write',
    'contents: write',
    'deployments: write',
    'id-token: write',
    'issues: write',
    'packages: write',
    'pages: write',
    'statuses: write',
  ]) {
    requireNotIncludes(
      permissions,
      widenedPermission,
      `Test workflow must not widen permissions with ${widenedPermission}.`,
      failures
    );
  }

  requireNotIncludes(
    source,
    'permissions: write-all',
    'Test workflow must not use write-all permissions.',
    failures
  );
  requireNotIncludes(
    source,
    'permissions: read-all',
    'Test workflow must not hide explicit permission scopes behind read-all.',
    failures
  );
  requireNotIncludes(
    source,
    'secrets: inherit',
    'Test workflow must not inherit all secrets into jobs or reusable workflows.',
    failures
  );
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
  requireIncludes(
    source,
    "cron: '23 7 * * *'",
    'Test workflow must keep scheduled full-matrix validation.',
    failures
  );
  requireIncludes(
    source,
    'release_proof:',
    'Manual workflow_dispatch must expose an explicit release_proof input.',
    failures
  );
  requireIncludes(
    source,
    'default: skip',
    'Manual workflow_dispatch release_proof input must default to skip.',
    failures
  );
  requireIncludes(
    source,
    '- full-release',
    'Manual workflow_dispatch release_proof input must offer full-release explicitly.',
    failures
  );
  requireIncludes(
    source,
    '- desktop-backgrounding',
    'Manual workflow_dispatch release_proof input must keep desktop backgrounding explicit.',
    failures
  );
  requireIncludes(
    source,
    'release-proof-dispatch-policy:',
    'Manual workflow_dispatch must include a cheap release proof policy summary job.',
    failures
  );
  const releaseProofPolicy = extractJob(source, 'release-proof-dispatch-policy');
  if (!releaseProofPolicy) {
    failures.push('Missing release-proof-dispatch-policy job.');
  } else {
    requireIncludes(
      releaseProofPolicy,
      'RELEASE_PROOF_MODE: ${{ inputs.release_proof }}',
      'Manual release proof policy must pass release_proof through env, not direct shell interpolation.',
      failures
    );
    requireIncludes(
      releaseProofPolicy,
      'RELEASE_PROOF_REASON: ${{ inputs.reason }}',
      'Manual release proof policy must pass reason through env, not direct shell interpolation.',
      failures
    );
    requireNotIncludes(
      releaseProofPolicy,
      'Selected mode: `${{ inputs.release_proof }}`',
      'Manual release proof policy must not interpolate release_proof directly into the run script.',
      failures
    );
    requireNotIncludes(
      releaseProofPolicy,
      'Reason: `${{ inputs.reason }}`',
      'Manual release proof policy must not interpolate free-text reason directly into the run script.',
      failures
    );
  }
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
  requireWorkflowSecurityContracts(source, failures);

  // Shard count is intentionally enforced in the workflow and this lint so CI
  // wall-time/cost changes are reviewed as explicit contract changes.
  const determineMatrix = extractJob(source, 'determine-matrix');
  if (!determineMatrix) {
    failures.push('Missing determine-matrix job.');
  } else {
    requireRiskLabelGate(
      determineMatrix,
      'Determine E2E Matrix',
      ['ci:web-e2e', 'ci:desktop'],
      failures
    );
    requireNoMainPushEvent(determineMatrix, 'Determine E2E Matrix', failures);
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
      'Desktop regression matrix must stay at four shards on PRs and release matrix.',
      failures
    );
    requireIncludes(
      determineMatrix,
      'desktop-shard-total=["4"]',
      'Desktop regression shard total must stay at four on PRs and release matrix.',
      failures
    );
  }

  const e2e = extractJob(source, 'e2e');
  if (!e2e) {
    failures.push('Missing e2e job.');
  } else {
    requireRiskLabelGate(e2e, 'Functional E2E', ['ci:web-e2e'], failures);
    requireNoMainPushEvent(e2e, 'Functional E2E', failures);
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
    requireRiskLabelGate(stateful, 'Stateful E2E', ['ci:web-e2e'], failures);
    requireNoMainPushEvent(stateful, 'Stateful E2E', failures);
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
    requireRiskLabelGate(destructive, 'Destructive E2E', ['ci:web-e2e'], failures);
    requireNoMainPushEvent(destructive, 'Destructive E2E', failures);
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

  const mergeReports = extractJob(source, 'merge-reports');
  if (!mergeReports) {
    failures.push('Missing merge-reports job.');
  } else {
    requireRiskLabelGate(
      mergeReports,
      'Merge Test Reports',
      [
        'ci:web-smoke',
        'ci:web-file-explorer-persistence',
        'ci:web-import-indexing',
        'ci:web-assistant-state',
        'ci:web-settings-state',
        'ci:web-db-startup',
        'ci:web-destructive-reset',
        'ci:web-e2e',
        'ci:desktop-smoke',
        'ci:desktop-ipc-reset',
        'ci:desktop-runtime-hosts',
        'ci:desktop-db-storage',
        'ci:desktop',
        'ci:embedding',
      ],
      failures
    );
    requireNoMainPushEvent(mergeReports, 'Merge Test Reports', failures);
    requireIncludes(
      mergeReports,
      'find all-blob-reports -type f -name "*.tar" -print0',
      'Merge Test Reports must extract tar bundles found anywhere under all-blob-reports.',
      failures
    );
    requireIncludes(
      mergeReports,
      'find all-blob-reports -type f -path "*/blob-report/*"',
      'Merge Test Reports must only run when extracted blob report files exist.',
      failures
    );
    requireIncludes(
      mergeReports,
      'find all-blob-reports -type d -name "blob-report" -print0',
      'Merge Test Reports must discover blob-report directories recursively.',
      failures
    );
    requireNotIncludes(
      mergeReports,
      'ls -la all-blob-reports/*/',
      'Merge Test Reports must not assume download-artifact creates per-artifact subdirectories.',
      failures
    );
  }

  for (const narrowLane of [
    {
      jobName: 'web-e2e-smoke-pr',
      label: 'ci:web-smoke',
      name: 'Web E2E Smoke',
      prefix: 'PR web smoke',
      script: 'pnpm --filter @brainstrike/web run test:e2e:lane:smoke',
      stepName: 'Run web smoke lane',
    },
    {
      jobName: 'web-e2e-file-explorer-persistence-pr',
      label: 'ci:web-file-explorer-persistence',
      name: 'Web E2E File Explorer Persistence',
      prefix: 'PR web file explorer persistence',
      script: 'pnpm --filter @brainstrike/web run test:e2e:lane:file-explorer-persistence',
      stepName: 'Run file explorer persistence lane',
    },
    {
      jobName: 'web-e2e-import-indexing-pr',
      label: 'ci:web-import-indexing',
      name: 'Web E2E Import Indexing',
      prefix: 'PR web import indexing',
      script: 'pnpm --filter @brainstrike/web run test:e2e:lane:import-indexing',
      stepName: 'Run import indexing lane',
    },
    {
      jobName: 'web-e2e-assistant-state-pr',
      label: 'ci:web-assistant-state',
      name: 'Web E2E Assistant State',
      prefix: 'PR web assistant state',
      script: 'pnpm --filter @brainstrike/web run test:e2e:lane:assistant-state',
      stepName: 'Run assistant state lane',
    },
    {
      jobName: 'web-e2e-settings-state-pr',
      label: 'ci:web-settings-state',
      name: 'Web E2E Settings State',
      prefix: 'PR web settings state',
      script: 'pnpm --filter @brainstrike/web run test:e2e:lane:settings-state',
      stepName: 'Run settings state lane',
    },
    {
      jobName: 'web-e2e-db-startup-pr',
      label: 'ci:web-db-startup',
      name: 'Web E2E DB Startup',
      prefix: 'PR web DB startup',
      script: 'pnpm --filter @brainstrike/web run test:e2e:lane:db-startup',
      stepName: 'Run DB startup lane',
    },
    {
      jobName: 'web-e2e-destructive-reset-pr',
      label: 'ci:web-destructive-reset',
      name: 'Web E2E Destructive Reset',
      prefix: 'PR web destructive reset',
      script: 'pnpm --filter @brainstrike/web run test:e2e:lane:destructive-reset',
      stepName: 'Run destructive reset lane',
    },
  ]) {
    const job = extractJob(source, narrowLane.jobName);
    if (!job) {
      failures.push(`Missing ${narrowLane.jobName} job.`);
      continue;
    }
    requireWebNarrowJobContracts(job, narrowLane, failures);
    if (narrowLane.jobName === 'web-e2e-smoke-pr') {
      requireMainPushEvent(job, 'Web E2E Smoke', failures);
    }
  }

  const desktopPr = extractJob(source, 'desktop-e2e-pr');
  if (!desktopPr) {
    failures.push('Missing desktop-e2e-pr job.');
  } else {
    requirePrRiskLabelGate(desktopPr, 'PR desktop regression', ['ci:desktop'], failures);
    requireIncludes(
      desktopPr,
      'name: Desktop E2E Regression',
      'PR desktop E2E status must prove the desktop regression suite.',
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
      '--workers=1',
      'PR desktop E2E must keep one worker per shard to avoid concurrent Electron/DB-host contention.',
      failures
    );
    requireDesktopRegressionJobContracts(desktopPr, 'PR', failures);
    if (desktopPr.includes('--project=smoke')) {
      failures.push('PR desktop E2E must not use smoke as the required desktop proof.');
    }
  }

  for (const narrowLane of [
    {
      jobName: 'desktop-e2e-smoke-pr',
      label: 'ci:desktop-smoke',
      name: 'Desktop E2E Smoke',
      prefix: 'PR desktop smoke',
      script: 'pnpm run test:e2e:lane:smoke',
    },
    {
      jobName: 'desktop-e2e-ipc-reset-pr',
      label: 'ci:desktop-ipc-reset',
      name: 'Desktop E2E IPC Reset',
      prefix: 'PR desktop IPC reset',
      script: 'pnpm run test:e2e:lane:ipc-reset',
    },
    {
      jobName: 'desktop-e2e-runtime-hosts-pr',
      label: 'ci:desktop-runtime-hosts',
      name: 'Desktop E2E Runtime Hosts',
      prefix: 'PR desktop runtime hosts',
      script: 'pnpm run test:e2e:lane:runtime-hosts',
    },
    {
      jobName: 'desktop-e2e-db-storage-pr',
      label: 'ci:desktop-db-storage',
      name: 'Desktop E2E DB Storage',
      prefix: 'PR desktop DB storage',
      script: 'pnpm run test:e2e:lane:db-storage',
    },
  ]) {
    const job = extractJob(source, narrowLane.jobName);
    if (!job) {
      failures.push(`Missing ${narrowLane.jobName} job.`);
      continue;
    }
    requireDesktopNarrowJobContracts(job, narrowLane, failures);
    if (narrowLane.jobName === 'desktop-e2e-smoke-pr') {
      requireMainPushEvent(job, 'Desktop E2E Smoke', failures);
    }
  }

  const desktopEmbeddingPr = extractJob(source, 'desktop-e2e-embedding-pr');
  if (!desktopEmbeddingPr) {
    failures.push('Missing desktop-e2e-embedding-pr job.');
  } else {
    requirePrRiskLabelGate(
      desktopEmbeddingPr,
      'PR desktop embedding regression',
      ['ci:embedding'],
      failures
    );
    requireIncludes(
      desktopEmbeddingPr,
      'name: Desktop E2E Embedding Regression',
      'PR desktop embedding E2E status must prove embedding regressions.',
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
      MANUAL_FULL_RELEASE_EXPR,
      'Release desktop regression job must require release_proof=full-release for manual release proof.',
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
      '--workers=1',
      'Main desktop E2E must keep one worker per shard to avoid concurrent Electron/DB-host contention.',
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
      MANUAL_FULL_RELEASE_EXPR,
      'Release desktop embedding regression job must require release_proof=full-release for manual release proof.',
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

  const desktopBackgrounding = extractJob(source, 'desktop-e2e-backgrounding');
  if (!desktopBackgrounding) {
    failures.push('Missing desktop-e2e-backgrounding job.');
  } else {
    requireIncludes(
      desktopBackgrounding,
      MANUAL_BACKGROUNDING_EXPR,
      'Desktop backgrounding diagnostic must require release_proof=desktop-backgrounding.',
      failures
    );
    requireNotIncludes(
      desktopBackgrounding,
      "if: github.event_name == 'workflow_dispatch'\n",
      'Desktop backgrounding diagnostic must not run on every manual workflow_dispatch event.',
      failures
    );
  }

  const prepareWeb = extractJob(source, 'prepare-web');
  if (!prepareWeb) {
    failures.push('Missing prepare-web job.');
  } else {
    requireMainPushAndRiskLabelGate(
      prepareWeb,
      'Build Web App',
      [
        'ci:web-smoke',
        'ci:web-file-explorer-persistence',
        'ci:web-import-indexing',
        'ci:web-assistant-state',
        'ci:web-settings-state',
        'ci:web-db-startup',
        'ci:web-destructive-reset',
        'ci:web-e2e',
      ],
      failures
    );
  }

  const prepareDesktop = extractJob(source, 'prepare-desktop');
  if (!prepareDesktop) {
    failures.push('Missing prepare-desktop job.');
  } else {
    requireMainPushAndRiskLabelGate(
      prepareDesktop,
      'Build Desktop App',
      [
        'ci:desktop-smoke',
        'ci:desktop-ipc-reset',
        'ci:desktop-runtime-hosts',
        'ci:desktop-db-storage',
        'ci:desktop',
        'ci:embedding',
      ],
      failures
    );
  }

  const unitAffected = extractJob(source, 'unit_affected');
  if (!unitAffected) {
    failures.push('Missing unit_affected job.');
  } else {
    requirePrRiskLabelGate(unitAffected, 'Checks (unit-affected)', ['ci:unit'], failures);
    // The affected-unit timeout is intentionally pinned: cold-cache full-risk runs have included
    // Electron, embedding-worker diagnostics, and dependent package builds. Change the workflow and
    // this contract together when measured runtimes justify tightening or widening it.
    requireNumericMatchAtMost(
      extractJobHeader(unitAffected),
      /^    timeout-minutes:\s*(\d+)\s*$/m,
      25,
      'Affected unit job timeout must stay bounded for PR feedback.',
      failures
    );
    requireNumericMatchAtLeast(
      extractJobHeader(unitAffected),
      /^    timeout-minutes:\s*(\d+)\s*$/m,
      25,
      'Affected unit job timeout must cover setup plus the test step.',
      failures
    );
    requireIncludes(
      unitAffected,
      '- name: Run affected unit tests',
      'Affected unit job must run a separate timed affected test step.',
      failures
    );
    requireIncludes(
      unitAffected,
      '- name: Detect selected unit proof mode',
      'Affected unit job must detect changed-unit-test proof mode before expanding Turbo affected tests.',
      failures
    );
    requireIncludes(
      unitAffected,
      'scripts/ci-unit-proof-mode.mjs',
      'Affected unit job must use the tested unit proof mode detector.',
      failures
    );
    requireIncludes(
      unitAffected,
      'node scripts/run-changed-unit-tests.mjs',
      'Affected unit job must run changed unit test files directly for isolated unit-test-only proof.',
      failures
    );
    requireIncludes(
      unitAffected,
      'turbo run test --filter="...[origin/${GITHUB_BASE_REF}]"',
      'Affected unit job must still support Turbo affected filtering against the PR base.',
      failures
    );
    requireStepTimeoutAtMost(
      unitAffected,
      'Run affected unit tests',
      20,
      'Affected unit test step timeout must stay bounded for PR feedback.',
      failures
    );
    requireStepTimeoutAtLeast(
      unitAffected,
      'Run affected unit tests',
      20,
      'Affected unit test step timeout must cover cold cache runs.',
      failures
    );
    requireNotIncludes(
      unitAffected,
      'test:coverage',
      'Affected unit job must not run coverage tasks.',
      failures
    );
  }

  const unitCoverage = extractJob(source, 'unit_coverage');
  if (!unitCoverage) {
    failures.push('Missing unit_coverage job.');
  } else {
    requireRiskLabelGate(
      unitCoverage,
      'Checks (coverage-db/full)',
      ['ci:coverage-db', 'ci:coverage-full'],
      failures
    );
    requireNoMainPushEvent(unitCoverage, 'Checks (coverage-db/full)', failures);
    requireNumericMatchAtLeast(
      extractJobHeader(unitCoverage),
      /^    timeout-minutes:\s*(\d+)\s*$/m,
      85,
      'Unit coverage job timeout must cover split coverage step budgets plus overhead.',
      failures
    );
    requireNumericMatchAtMost(
      extractJobHeader(unitCoverage),
      /^    timeout-minutes:\s*(\d+)\s*$/m,
      90,
      'Unit coverage job timeout must stay at 90 minutes or less.',
      failures
    );
    for (const jobLevelCoverageEnv of ['COVERAGE:', 'NODE_ENV:', 'TURBO_TEST_MODE:']) {
      requireNotIncludes(
        extractJobHeader(unitCoverage),
        jobLevelCoverageEnv,
        'Unit coverage must scope coverage/test env to coverage steps, not setup.',
        failures
      );
    }
    requireStepTimeoutAtMost(
      unitCoverage,
      'Run affected package unit coverage',
      30,
      'Unit coverage package and DB serial steps must stay at 30 minutes or less.',
      failures
    );
    requireIncludes(
      unitCoverage,
      '- name: Run affected package unit coverage',
      'Unit coverage must keep affected package coverage in a separate timed step.',
      failures
    );
    requireIncludes(
      unitCoverage,
      '- name: Run DB runtime coverage',
      'Unit coverage must keep DB runtime coverage in a separate timed step.',
      failures
    );
    requireStepTimeoutAtMost(
      unitCoverage,
      'Run DB runtime coverage',
      10,
      'DB runtime coverage must keep a tight isolated timeout.',
      failures
    );
    requireIncludes(
      unitCoverage,
      '- name: Run DB serial coverage lanes',
      'Unit coverage must keep serial DB coverage lanes in a separate timed step.',
      failures
    );
    requireStepTimeoutAtMost(
      unitCoverage,
      'Run DB serial coverage lanes',
      30,
      'Unit coverage package and DB serial steps must stay at 30 minutes or less.',
      failures
    );
    requireIncludes(
      unitCoverage,
      '- name: Prepare unit coverage workspace',
      'Unit coverage must prepare merged workspace coverage in a separate output step.',
      failures
    );
    requireStepTimeoutAtMost(
      unitCoverage,
      'Prepare unit coverage workspace',
      5,
      'Coverage workspace preparation must keep a tight timeout.',
      failures
    );
    requireIncludes(
      unitCoverage,
      'rm -rf .turbo/runs',
      'Unit coverage must clear stale Turbo summaries before the split coverage phases.',
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
    requireNotIncludes(
      unitCoverage,
      "steps.unit-tests.outcome != 'skipped'",
      'Unit coverage timing diagnostics must still run when an earlier coverage phase fails.',
      failures
    );
    requireIncludes(
      unitCoverage,
      '--warn-ms 600000 --fail-ms 900000',
      'Unit coverage package task timing thresholds must stay capped at 10m warn / 15m fail.',
      failures
    );
    requireIncludes(
      unitCoverage,
      '--total-warn-ms 2100000 --total-fail-ms 2400000',
      'Unit coverage aggregate timing thresholds must stay capped at 35m warn / 40m fail.',
      failures
    );
  }

  const checks = extractJob(source, 'checks');
  if (!checks) {
    failures.push('Missing checks job.');
  } else {
    requireIncludes(
      checks,
      "github.event_name != 'workflow_dispatch'",
      'Checks (static) must not run on unconfirmed manual workflow_dispatch events.',
      failures
    );
    requireIncludes(
      checks,
      MANUAL_FULL_RELEASE_EXPR,
      'Checks (static) must run when manual release_proof=full-release is selected.',
      failures
    );
  }

  const browserTests = extractJob(source, 'browser-tests');
  if (!browserTests) {
    failures.push('Missing browser-tests job.');
  } else {
    requireRiskLabelGate(browserTests, 'Browser Vitest', ['ci:browser'], failures);
    requireNoMainPushEvent(browserTests, 'Browser Vitest', failures);
    requirePreprovisionedPlaywrightJobContracts(browserTests, 'Browser Vitest', failures);
  }

  const prSentinel = extractJob(source, 'pr-sentinel');
  if (!prSentinel) {
    failures.push('Missing pr-sentinel job.');
  } else {
    requireIncludes(
      prSentinel,
      'name: PR Sentinel',
      'PR Sentinel status name must stay stable.',
      failures
    );
    requireIncludes(
      prSentinel,
      "if: github.event_name == 'pull_request'",
      'PR Sentinel must only run on pull_request.',
      failures
    );
    requireIncludes(
      prSentinel,
      'timeout-minutes: 10',
      'PR Sentinel must keep a tight ten minute timeout.',
      failures
    );
    requireIncludes(
      prSentinel,
      'uses: actions/checkout@v6',
      'PR Sentinel must use actions/checkout@v6.',
      failures
    );
    requireIncludes(
      prSentinel,
      'fetch-depth: 0',
      'PR Sentinel checkout must fetch full history for proof ancestry checks.',
      failures
    );
    requireIncludes(
      prSentinel,
      'uses: ./.github/actions/setup-monorepo',
      'PR Sentinel must use the shared monorepo setup action.',
      failures
    );
    requireIncludes(
      prSentinel,
      'pnpm ci:verify-proof',
      'PR Sentinel must verify the local proof manifest.',
      failures
    );
    requireIncludes(
      prSentinel,
      'PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}',
      'PR Sentinel must verify proof against the pull request head SHA, not the synthetic merge commit.',
      failures
    );
    requireIncludes(
      prSentinel,
      '--head "$PR_HEAD_SHA"',
      'PR Sentinel must pass the pull request head SHA to the proof verifier.',
      failures
    );
    requireNotIncludes(
      prSentinel,
      '--head "$GITHUB_SHA"',
      'PR Sentinel must not verify proof against GITHUB_SHA because pull_request events use a synthetic merge commit.',
      failures
    );
    requireIncludes(
      prSentinel,
      'gh pr view "$PR_NUMBER" --json labels',
      'PR Sentinel must fetch live pull request labels before proof verification.',
      failures
    );
    requireIncludes(
      prSentinel,
      'PR_LABELS: ${{ steps.pr-labels.outputs.labels }}',
      'PR Sentinel must pass live pull request labels to the proof verifier.',
      failures
    );
    for (const outputName of ['required-labels', 'expanded-lanes', 'tested-head-sha']) {
      requireIncludes(
        prSentinel,
        outputName,
        `PR Sentinel must write the ${outputName} output.`,
        failures
      );
    }
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
      'pr-sentinel',
      'checks',
      'unit_affected',
      'unit_coverage',
      'browser-tests',
      'prepare-web',
      'prepare-desktop',
      'e2e',
      'e2e-stateful',
      'e2e-destructive',
      'desktop-e2e-pr',
      'desktop-e2e-smoke-pr',
      'desktop-e2e-ipc-reset-pr',
      'desktop-e2e-runtime-hosts-pr',
      'desktop-e2e-db-storage-pr',
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
      "const alwaysRequiredJobs = ['pr-sentinel', 'checks'];",
      'Required PR Gate must define always-required PR jobs.',
      failures
    );
    requireIncludes(
      requiredPrGate,
      "if (needs[jobName]?.result !== 'success')",
      'Required PR Gate must require PR Sentinel success.',
      failures
    );
    requireIncludes(
      requiredPrGate,
      "'checks'",
      'Required PR Gate must require static checks success.',
      failures
    );
    requireIncludes(
      requiredPrGate,
      'REQUIRED_LABELS: ${{ needs.pr-sentinel.outputs.required-labels }}',
      'Required PR Gate must read selected labels from PR Sentinel outputs.',
      failures
    );
    requireIncludes(
      requiredPrGate,
      "jobByLabel.get(label)",
      'Required PR Gate must map selected risk labels to matching cloud jobs.',
      failures
    );
    for (const [label, jobs] of [
      ['ci:unit', ['unit_affected']],
      ['ci:coverage-db', ['unit_coverage']],
      ['ci:coverage-full', ['unit_coverage']],
      ['ci:browser', ['browser-tests']],
      ['ci:web-smoke', ['prepare-web', 'web-e2e-smoke-pr']],
      ['ci:web-file-explorer-persistence', ['prepare-web', 'web-e2e-file-explorer-persistence-pr']],
      ['ci:web-import-indexing', ['prepare-web', 'web-e2e-import-indexing-pr']],
      ['ci:web-assistant-state', ['prepare-web', 'web-e2e-assistant-state-pr']],
      ['ci:web-settings-state', ['prepare-web', 'web-e2e-settings-state-pr']],
      ['ci:web-db-startup', ['prepare-web', 'web-e2e-db-startup-pr']],
      ['ci:web-destructive-reset', ['prepare-web', 'web-e2e-destructive-reset-pr']],
      ['ci:web-e2e', ['prepare-web', 'e2e', 'e2e-stateful', 'e2e-destructive']],
      ['ci:desktop-smoke', ['prepare-desktop', 'desktop-e2e-smoke-pr']],
      ['ci:desktop-ipc-reset', ['prepare-desktop', 'desktop-e2e-ipc-reset-pr']],
      ['ci:desktop-runtime-hosts', ['prepare-desktop', 'desktop-e2e-runtime-hosts-pr']],
      ['ci:desktop-db-storage', ['prepare-desktop', 'desktop-e2e-db-storage-pr']],
      ['ci:desktop', ['prepare-desktop', 'desktop-e2e-pr']],
      ['ci:embedding', ['prepare-desktop', 'desktop-e2e-embedding-pr']],
    ]) {
      requireIncludes(
        requiredPrGate,
        `['${label}', [${jobs.map((job) => `'${job}'`).join(', ')}]]`,
        `Required PR Gate must map ${label} to ${jobs.join(', ')}.`,
        failures
      );
    }
    requireIncludes(
      requiredPrGate,
      "if (needs[jobName]?.result !== 'success') {\n                failures.push(`${label} requires ${jobName}, got ${needs[jobName]?.result ?? 'missing'}`);",
      'Required PR Gate must fail when a selected risk lane is skipped, failed, or cancelled.',
      failures
    );
    requireIncludes(
      requiredPrGate,
      "job.result === 'failure' || job.result === 'cancelled' || job.result === 'timed_out'",
      'Required PR Gate must fail failed, cancelled, and timed out optional jobs.',
      failures
    );
    requireNotIncludes(
      requiredPrGate,
      "job.result !== 'success'",
      'Required PR Gate must not require unselected skipped jobs to succeed.',
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
      'prepare-web',
      'prepare-desktop',
      'web-e2e-smoke-pr',
      'desktop-e2e-smoke-pr',
    ]) {
      requireYamlListItem(
        requiredMainGate,
        jobName,
        `Required Main Gate must depend on ${jobName}.`,
        failures
      );
    }
    for (const jobName of [
      'unit_coverage',
      'browser-tests',
      'e2e',
      'e2e-stateful',
      'e2e-destructive',
      'desktop-e2e-main',
      'desktop-e2e-embedding-main',
      'merge-reports',
    ]) {
      requireNotIncludes(
        requiredMainGate,
        `\n      - ${jobName}`,
        `Required Main Gate must not depend on release-only job ${jobName}.`,
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

  const requiredReleaseGate = extractJob(source, 'required-release-gate');
  if (!requiredReleaseGate) {
    failures.push('Missing required-release-gate job.');
  } else {
    requireIncludes(
      requiredReleaseGate,
      'name: Required Release Gate',
      'Required Release Gate status name must stay stable for release proof.',
      failures
    );
    requireIncludes(
      requiredReleaseGate,
      "github.event_name == 'schedule'",
      'Required Release Gate must run for scheduled release proof.',
      failures
    );
    requireIncludes(
      requiredReleaseGate,
      MANUAL_FULL_RELEASE_EXPR,
      'Required Release Gate must require release_proof=full-release for manual release proof.',
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
        requiredReleaseGate,
        jobName,
        `Required Release Gate must depend on ${jobName}.`,
        failures
      );
    }
    requireIncludes(
      requiredReleaseGate,
      "job.result !== 'success'",
      'Required Release Gate must fail unless every release dependency succeeds.',
      failures
    );
  }

  const codeQuality = extractJob(source, 'code-quality');
  if (!codeQuality) {
    failures.push('Missing code-quality job.');
  } else {
    requireIncludes(
      codeQuality,
      "if: github.event_name == 'pull_request' || github.event_name == 'schedule'",
      'Code Quality must not run on every main push.',
      failures
    );
    requireNotIncludes(
      codeQuality,
      "github.event_name != 'workflow_dispatch'",
      'Code Quality must not use a broad non-workflow_dispatch gate.',
      failures
    );
    requireNotIncludes(
      extractJobHeader(codeQuality),
      "github.event_name == 'push'",
      'Code Quality must not run on every main push.',
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

export function validateTurboContracts(source) {
  const failures = [];
  const browserTask = extractJsonObjectBlock(source, 'test:browser');
  if (!browserTask) {
    failures.push('Missing Turborepo test:browser task.');
    return failures;
  }

  requireIncludes(
    browserTask,
    '"PLAYWRIGHT_BROWSERS_PATH"',
    'Turborepo test:browser task must pass PLAYWRIGHT_BROWSERS_PATH through to package scripts.',
    failures
  );
  requireIncludes(
    browserTask,
    '"CI"',
    'Turborepo test:browser task must pass CI through to package browser tests.',
    failures
  );

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
    claudeReviewWorkflowSource,
    setupMonorepoActionSource,
    setupDesktopE2EActionSource,
    turboConfigSource,
    desktopPlaywrightConfigSource,
    playwrightEnvironmentSource,
  ] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(claudeReviewWorkflowPath, 'utf8'),
    readFile(setupMonorepoActionPath, 'utf8'),
    readFile(setupDesktopE2EActionPath, 'utf8'),
    readFile(turboConfigPath, 'utf8'),
    readFile(desktopPlaywrightConfigPath, 'utf8'),
    readFile(playwrightEnvironmentPath, 'utf8'),
  ]);
  const failures = [
    ...validateWorkflowContracts(source),
    ...validateClaudeReviewWorkflowContracts(claudeReviewWorkflowSource),
    ...validateSetupMonorepoContracts(setupMonorepoActionSource),
    ...validateSetupDesktopE2EContracts(setupDesktopE2EActionSource),
    ...validateTurboContracts(turboConfigSource),
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
