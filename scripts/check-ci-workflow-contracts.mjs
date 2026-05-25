#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PLAN_JOB_IDS } from './ci-plan.mjs';

const rootDir = process.cwd();
const workflowPath = path.join(rootDir, '.github/workflows/test.yml');
const claudeReviewWorkflowPath = path.join(rootDir, '.github/workflows/claude-code-review.yml');
const setupMonorepoActionPath = path.join(rootDir, '.github/actions/setup-monorepo/action.yml');
const setupDesktopE2EActionPath = path.join(rootDir, '.github/actions/setup-desktop-e2e/action.yml');
const setupPlaywrightRuntimeActionPath = path.join(
  rootDir,
  '.github/actions/setup-playwright-runtime/action.yml'
);
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

function requirePrPlanOutputGate(job, jobName, outputName, failures) {
  requireIncludes(
    job,
    "github.event_name == 'pull_request'",
    `${jobName} must be gated to pull_request when reading CI Plan outputs.`,
    failures
  );
  requireIncludes(
    job,
    `needs.plan.outputs.${outputName} == 'true'`,
    `${jobName} must use CI Plan output ${outputName}.`,
    failures
  );
  requireNotIncludes(
    job,
    'github.event.pull_request.labels',
    `${jobName} must not read pull request labels for routing.`,
    failures
  );
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
    'uses: ./.github/actions/setup-playwright-runtime',
    `${prefix} desktop embedding job must use the cached Playwright runtime setup action.`,
    failures
  );
  requireNotIncludes(
    source,
    'mcr.microsoft.com/playwright',
    `${prefix} desktop embedding job must not depend on the MCR Playwright container image.`,
    failures
  );
  requireNotIncludes(
    source,
    'container:',
    `${prefix} desktop embedding job must not use a job container before fail-fast setup can run.`,
    failures
  );
  requireNotIncludes(
    source,
    'apt-get',
    `${prefix} desktop embedding job must not run apt-get inline in the required shard path.`,
    failures
  );
  requireNotIncludes(
    source,
    'sudo ',
    `${prefix} desktop embedding job must not require sudo inline in the required shard path.`,
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
    'uses: ./.github/actions/setup-playwright-runtime',
    `${prefix} desktop regression job must use the cached Playwright runtime setup action.`,
    failures
  );
  requireNotIncludes(
    source,
    'mcr.microsoft.com/playwright',
    `${prefix} desktop regression job must not depend on the MCR Playwright container image.`,
    failures
  );
  requireNotIncludes(
    source,
    'container:',
    `${prefix} desktop regression job must not use a job container before fail-fast setup can run.`,
    failures
  );
  requireNotIncludes(
    source,
    'apt-get',
    `${prefix} desktop regression job must not run apt-get inline in the required shard path.`,
    failures
  );
  requireNotIncludes(
    source,
    'sudo ',
    `${prefix} desktop regression job must not require sudo inline in the required shard path.`,
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
    'uses: ./.github/actions/setup-playwright-runtime',
    `${prefix} must use the cached Playwright runtime setup action.`,
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
    'mcr.microsoft.com/playwright',
    `${prefix} must not depend on the MCR Playwright container image.`,
    failures
  );
  requireNotIncludes(
    source,
    'container:',
    `${prefix} must not use a job container before fail-fast setup can run.`,
    failures
  );
  requireNotIncludes(source, 'apt-get', `${prefix} must not run apt-get inline.`, failures);
  requireNotIncludes(source, 'sudo ', `${prefix} must not require sudo inline.`, failures);
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
    'uses: ./.github/actions/setup-playwright-runtime',
    `${prefix} must use the cached Playwright runtime setup action.`,
    failures
  );
  requireNotIncludes(
    source,
    'mcr.microsoft.com/playwright',
    `${prefix} must not depend on the MCR Playwright container image.`,
    failures
  );
  requireNotIncludes(
    source,
    'container:',
    `${prefix} must not use a job container before fail-fast setup can run.`,
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

function requirePlaywrightRuntimeJobContracts(source, prefix, failures) {
  requireIncludes(
    source,
    'uses: ./.github/actions/setup-playwright-runtime',
    `${prefix} Playwright job must use the cached Playwright runtime setup action.`,
    failures
  );
  requireNotIncludes(
    source,
    'mcr.microsoft.com/playwright',
    `${prefix} Playwright job must not depend on the MCR Playwright container image.`,
    failures
  );
  requireNotIncludes(
    source,
    'container:',
    `${prefix} Playwright job must not use a job container before fail-fast setup can run.`,
    failures
  );
  requireNotIncludes(
    source,
    'PLAYWRIGHT_BROWSERS_PATH: /ms-playwright',
    `${prefix} Playwright job must not assume image-provided browsers at /ms-playwright.`,
    failures
  );
  requireNotIncludes(
    source,
    'apt-get',
    `${prefix} Playwright job must not run apt-get inline in the workflow job.`,
    failures
  );
  requireNotIncludes(
    source,
    'sudo ',
    `${prefix} Playwright job must not require sudo inline in the workflow job.`,
    failures
  );
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
  for (const eventType of [
    'opened',
    'synchronize',
    'reopened',
    'ready_for_review',
  ]) {
    requireIncludes(
      source,
      `      - ${eventType}`,
      `Test workflow pull_request trigger must include ${eventType}.`,
      failures
    );
  }
  for (const eventType of ['labeled', 'unlabeled']) {
    requireNotIncludes(
      source,
      `      - ${eventType}`,
      `Test workflow pull_request trigger must not rerun on ${eventType}; CI Plan is computed from the diff.`,
      failures
    );
  }
  requireNotIncludes(
    source,
    'github.event.pull_request.labels',
    'Test workflow must not route PR checks from mutable pull request labels.',
    failures
  );
  requireNotIncludes(
    source,
    'ci:verify-proof',
    'Test workflow must not require legacy local proof verification.',
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
    requireReleaseMatrixEvents(determineMatrix, 'Determine E2E Matrix', failures);
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
    requireReleaseMatrixEvents(e2e, 'Functional E2E', failures);
    requireNoMainPushEvent(e2e, 'Functional E2E', failures);
    requirePlaywrightRuntimeJobContracts(e2e, 'Functional E2E', failures);
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
    requireReleaseMatrixEvents(stateful, 'Stateful E2E', failures);
    requireNoMainPushEvent(stateful, 'Stateful E2E', failures);
    requirePlaywrightRuntimeJobContracts(stateful, 'Stateful E2E', failures);
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
    requireReleaseMatrixEvents(destructive, 'Destructive E2E', failures);
    requireNoMainPushEvent(destructive, 'Destructive E2E', failures);
    requirePlaywrightRuntimeJobContracts(destructive, 'Destructive E2E', failures);
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
    requireReleaseMatrixEvents(mergeReports, 'Merge Test Reports', failures);
    requirePrPlanOutputGate(mergeReports, 'Merge Test Reports', 'run-merge-reports', failures);
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

  const webE2ePr = extractJob(source, 'web-e2e-pr');
  if (!webE2ePr) {
    failures.push('Missing web-e2e-pr job.');
  } else {
    requirePrPlanOutputGate(webE2ePr, 'Web E2E PR', 'run-web-e2e-pr', failures);
    requireIncludes(
      webE2ePr,
      'matrix: ${{ fromJSON(needs.plan.outputs.web-e2e-matrix) }}',
      'Web E2E PR must use the CI Plan web matrix.',
      failures
    );
    requireIncludes(
      webE2ePr,
      'run: ${{ matrix.command }}',
      'Web E2E PR must execute the selected lane command from CI Plan.',
      failures
    );
    requireIncludes(
      webE2ePr,
      'needs: [plan, checks, prepare-web]',
      'Web E2E PR must depend on plan, checks, and the prepared web artifact.',
      failures
    );
    requirePlaywrightRuntimeJobContracts(webE2ePr, 'Web E2E PR', failures);
    requireNotIncludes(
      webE2ePr,
      'test:e2e:lane:full-regression',
      'Web E2E PR must not hard-code full regression as a hidden fallback.',
      failures
    );
  }

  const webSmoke = extractJob(source, 'web-e2e-smoke-pr');
  if (!webSmoke) {
    failures.push('Missing web-e2e-smoke-pr job.');
  } else {
    requireMainPushEvent(webSmoke, 'Web E2E Smoke', failures);
    requireNotIncludes(
      webSmoke,
      "github.event_name == 'pull_request'",
      'Web E2E Smoke must not run for PRs outside CI Plan.',
      failures
    );
  }

  const desktopPr = extractJob(source, 'desktop-e2e-pr');
  if (!desktopPr) {
    failures.push('Missing desktop-e2e-pr job.');
  } else {
    requirePrPlanOutputGate(desktopPr, 'Desktop E2E PR', 'run-desktop-e2e-pr', failures);
    requireIncludes(
      desktopPr,
      'name: Desktop E2E PR (${{ matrix.lane }})',
      'PR desktop E2E status must show the selected lane.',
      failures
    );
    requireIncludes(
      desktopPr,
      'matrix: ${{ fromJSON(needs.plan.outputs.desktop-e2e-matrix) }}',
      'Desktop E2E PR must use the CI Plan desktop matrix.',
      failures
    );
    requireIncludes(
      desktopPr,
      '${{ matrix.command }}',
      'Desktop E2E PR must execute the selected lane command from CI Plan.',
      failures
    );
    requireIncludes(
      desktopPr,
      'needs: [plan, prepare-desktop]',
      'Desktop E2E PR must depend on plan and the prepared desktop artifact.',
      failures
    );
    requireNumericMatchAtMost(
      extractJobHeader(desktopPr),
      /^    timeout-minutes:\s*(\d+)\s*$/m,
      20,
      'Desktop E2E PR job timeout must stay at 20 minutes or less.',
      failures
    );
    requireNumericMatchAtLeast(
      extractJobHeader(desktopPr),
      /^    timeout-minutes:\s*(\d+)\s*$/m,
      20,
      'Desktop E2E PR job timeout must cover setup plus selected lane execution.',
      failures
    );
    requireIncludes(
      desktopPr,
      'uses: ./.github/actions/setup-playwright-runtime',
      'Desktop E2E PR must use the cached Playwright runtime setup action.',
      failures
    );
    requireIncludes(
      desktopPr,
      'uses: ./.github/actions/setup-desktop-e2e',
      'Desktop E2E PR must use the shared desktop E2E setup action.',
      failures
    );
    requireNotIncludes(
      desktopPr,
      'mcr.microsoft.com/playwright',
      'Desktop E2E PR must not depend on the MCR Playwright container image.',
      failures
    );
    requireNotIncludes(
      desktopPr,
      'container:',
      'Desktop E2E PR must not use a job container before fail-fast setup can run.',
      failures
    );
    requireNotIncludes(desktopPr, 'apt-get', 'Desktop E2E PR must not run apt-get inline.', failures);
    requireNotIncludes(desktopPr, 'sudo ', 'Desktop E2E PR must not require sudo inline.', failures);
    requireNotIncludes(
      desktopPr,
      '--shard=',
      'Desktop E2E PR must not silently shard all desktop regression for every desktop lane.',
      failures
    );
  }

  const desktopSmoke = extractJob(source, 'desktop-e2e-smoke-pr');
  if (!desktopSmoke) {
    failures.push('Missing desktop-e2e-smoke-pr job.');
  } else {
    requireMainPushEvent(desktopSmoke, 'Desktop E2E Smoke', failures);
    requireNotIncludes(
      desktopSmoke,
      "github.event_name == 'pull_request'",
      'Desktop E2E Smoke must not run for PRs outside CI Plan.',
      failures
    );
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
    requireMainPushEvent(prepareWeb, 'Build Web App', failures);
    requireReleaseMatrixEvents(prepareWeb, 'Build Web App', failures);
    requirePrPlanOutputGate(prepareWeb, 'Build Web App', 'run-prepare-web', failures);
  }

  const prepareDesktop = extractJob(source, 'prepare-desktop');
  if (!prepareDesktop) {
    failures.push('Missing prepare-desktop job.');
  } else {
    requireMainPushEvent(prepareDesktop, 'Build Desktop App', failures);
    requireReleaseMatrixEvents(prepareDesktop, 'Build Desktop App', failures);
    requirePrPlanOutputGate(
      prepareDesktop,
      'Build Desktop App',
      'run-prepare-desktop',
      failures
    );
  }

  const unitAffected = extractJob(source, 'unit_affected');
  if (!unitAffected) {
    failures.push('Missing unit_affected job.');
  } else {
    requirePrPlanOutputGate(unitAffected, 'Checks (unit-affected)', 'run-unit-affected', failures);
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
      'UNIT_MODE: ${{ needs.plan.outputs.unit-mode }}',
      'Affected unit job must read changed-unit-test mode from CI Plan.',
      failures
    );
    requireNotIncludes(
      unitAffected,
      'scripts/ci-unit-proof-mode.mjs',
      'Affected unit job must not read unit mode from the removed manifest path.',
      failures
    );
    requireIncludes(
      unitAffected,
      'node scripts/run-changed-unit-tests.mjs',
      'Affected unit job must run changed unit test files directly for isolated unit-test-only changes.',
      failures
    );
    requireIncludes(
      unitAffected,
      'turbo run test --filter="...[origin/${GITHUB_BASE_REF}]"',
      'Affected unit job must still support Turbo affected filtering against the PR base.',
      failures
    );
    requireIncludes(
      unitAffected,
      'rm -rf .turbo/runs',
      'Affected unit job must clear stale Turbo summaries before the affected unit phase.',
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
    requireReleaseMatrixEvents(unitCoverage, 'Checks (coverage-db/full)', failures);
    requirePrPlanOutputGate(
      unitCoverage,
      'Checks (coverage-db/full)',
      'run-unit-coverage',
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
    requireMainPushEvent(checks, 'Checks (static)', failures);
    requireReleaseMatrixEvents(checks, 'Checks (static)', failures);
    requirePrPlanOutputGate(checks, 'Checks (static)', 'run-checks', failures);
    requireIncludes(
      checks,
      'needs: [plan]',
      'Checks (static) must depend on CI Plan so PR routing is computed before job selection.',
      failures
    );
  }

  const browserTests = extractJob(source, 'browser-tests');
  if (!browserTests) {
    failures.push('Missing browser-tests job.');
  } else {
    requireReleaseMatrixEvents(browserTests, 'Browser Vitest', failures);
    requirePrPlanOutputGate(browserTests, 'Browser Vitest', 'run-browser-tests', failures);
    requireNoMainPushEvent(browserTests, 'Browser Vitest', failures);
    requirePlaywrightRuntimeJobContracts(browserTests, 'Browser Vitest', failures);
  }

  const plan = extractJob(source, 'plan');
  if (!plan) {
    failures.push('Missing plan job.');
  } else {
    requireIncludes(
      plan,
      'name: CI Plan',
      'CI Plan status name must stay stable.',
      failures
    );
    requireIncludes(
      plan,
      'node scripts/ci-plan.mjs',
      'CI Plan must use the tested planner script.',
      failures
    );
    requireIncludes(
      plan,
      '--github-output "$GITHUB_OUTPUT"',
      'CI Plan must write machine-readable GitHub outputs.',
      failures
    );
    requireIncludes(
      plan,
      'uses: actions/checkout@v6',
      'CI Plan must use actions/checkout@v6.',
      failures
    );
    requireIncludes(
      plan,
      'fetch-depth: 0',
      'CI Plan checkout must fetch full history for deterministic diff selection.',
      failures
    );
    requireIncludes(
      plan,
      '--head "$PR_HEAD_SHA" --base "origin/${GITHUB_BASE_REF}"',
      'CI Plan must compute PR risk from the pull request head against the base branch.',
      failures
    );
    requireNotIncludes(
      plan,
      'gh pr view',
      'CI Plan must not read live pull request labels.',
      failures
    );
    for (const outputName of [
      'required-jobs-json',
      'run-docs-static',
      'run-checks',
      'run-unit-affected',
      'run-unit-coverage',
      'run-browser-tests',
      'run-prepare-web',
      'run-web-e2e-pr',
      'run-prepare-desktop',
      'run-desktop-e2e-pr',
      'run-merge-reports',
      'web-e2e-matrix',
      'desktop-e2e-matrix',
    ]) {
      requireIncludes(
        plan,
        outputName,
        `CI Plan must write the ${outputName} output.`,
        failures
      );
    }
  }

  const docsStatic = extractJob(source, 'docs-static');
  if (docsStatic) {
    requireIncludes(
      docsStatic,
      'fetch-depth: 0',
      'Docs Static checkout must fetch enough history for explicit diff validation.',
      failures
    );
    requireIncludes(
      docsStatic,
      'DOCS_DIFF_BASE_SHA',
      'Docs Static must use an explicit base SHA for git diff --check.',
      failures
    );
    requireIncludes(
      docsStatic,
      'DOCS_DIFF_HEAD_SHA',
      'Docs Static must use an explicit head SHA for git diff --check.',
      failures
    );
    requireIncludes(
      docsStatic,
      'git diff --check "$DOCS_DIFF_BASE_SHA" "$DOCS_DIFF_HEAD_SHA"',
      'Docs Static must run git diff --check against explicit base and head refs.',
      failures
    );
    requireNotIncludes(
      docsStatic,
      'git diff --check -- docs apps/docs README.md AGENTS.md CLAUDE.md',
      'Docs Static must not run git diff --check without explicit refs on a clean CI checkout.',
      failures
    );
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
    requireIncludes(
      requiredPrGate,
      'uses: actions/checkout@v6',
      'Required PR Gate must checkout the repo before running the gate script.',
      failures
    );
    for (const jobName of ['plan', ...PLAN_JOB_IDS]) {
      requireYamlListItem(
        requiredPrGate,
        jobName,
        `Required PR Gate must depend on ${jobName}.`,
        failures
      );
    }
    requireIncludes(
      requiredPrGate,
      'REQUIRED_JOBS_JSON: ${{ needs.plan.outputs.required-jobs-json }}',
      'Required PR Gate must read required jobs from CI Plan outputs.',
      failures
    );
    requireIncludes(
      requiredPrGate,
      'node scripts/ci-required-pr-gate.mjs',
      'Required PR Gate must use the tested gate script.',
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
      "hashFiles('pnpm-lock.yaml', 'turbo.jsonc', 'tsconfig*.json', 'apps/*/tsconfig*.json', 'packages/*/tsconfig*.json', 'packages/*/tsconfig/*.json')",
      'Setup monorepo Turborepo cache key must include scoped lockfile, turbo config, and first-party tsconfig inputs.',
      failures
    );
    requireNotIncludes(
      turboCacheStep,
      "'**/tsconfig*.json'",
      'Setup monorepo Turborepo cache key must not hash ignored worktree or generated tsconfig files.',
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
  requireIncludes(
    source,
    '"tsconfig*.json"',
    'Turborepo global dependencies must include root TypeScript config files.',
    failures
  );
  requireIncludes(
    source,
    '"apps/*/tsconfig*.json"',
    'Turborepo global dependencies must include app TypeScript config files.',
    failures
  );
  requireIncludes(
    source,
    '"packages/*/tsconfig*.json"',
    'Turborepo global dependencies must include package TypeScript config files.',
    failures
  );
  requireIncludes(
    source,
    '"packages/*/tsconfig/*.json"',
    'Turborepo global dependencies must include shared tsconfig preset files.',
    failures
  );
  requireNotIncludes(
    source,
    '"**/tsconfig*.json"',
    'Turborepo global dependencies must not hash ignored worktree or generated tsconfig files.',
    failures
  );

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
    /Verify Electron runtime dependencies/,
    'Setup desktop E2E dependency verification step',
    failures
  );

  if (systemDepsStep) {
    requireIncludes(
      systemDepsStep,
      'command -v Xvfb >/dev/null',
      'Setup desktop E2E must verify Xvfb is present after Playwright runtime setup.',
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

export function validateSetupPlaywrightRuntimeContracts(source) {
  const failures = [];
  const installRuntimeStep =
    extractBlock(
      source,
      /^\s{4}- name: Install Playwright runtime\s*$/m,
      /\n\s{4}- name: /
    ) ?? '';
  const installRuntimeRun = installRuntimeStep.match(/run:\s*\|([\s\S]*)/)?.[1] ?? '';

  requireIncludes(
    source,
    'pnpm exec playwright --version',
    'Setup Playwright runtime must resolve the project Playwright version.',
    failures
  );
  requireIncludes(
    source,
    'actions/cache@v5',
    'Setup Playwright runtime must cache browser binaries.',
    failures
  );
  requireIncludes(
    source,
    '~/.cache/ms-playwright',
    'Setup Playwright runtime must cache the default Playwright browser path.',
    failures
  );
  requireIncludes(
    source,
    'PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright',
    'Setup Playwright runtime must export the cached browser path for Turbo/Vitest jobs.',
    failures
  );
  requireIncludes(
    source,
    'GITHUB_ENV',
    'Setup Playwright runtime must persist the browser path to later workflow steps.',
    failures
  );
  requireIncludes(
    source,
    'pnpm exec playwright install --with-deps',
    'Setup Playwright runtime must install browsers and system dependencies inside the job.',
    failures
  );
  requireIncludes(
    installRuntimeStep,
    'PLAYWRIGHT_INSTALL_BROWSERS: ${{ inputs.browsers }}',
    'Setup Playwright runtime must pass requested browsers through an environment variable.',
    failures
  );
  requireIncludes(
    installRuntimeRun,
    'requested_browsers',
    'Setup Playwright runtime must validate requested browser names before invoking Playwright.',
    failures
  );
  requireNotIncludes(
    installRuntimeRun,
    '${{ inputs.browsers }}',
    'Setup Playwright runtime must not interpolate action input directly into shell.',
    failures
  );
  requireIncludes(
    source,
    'chromium.launch',
    'Setup Playwright runtime must prove Chromium launches before running E2E lanes.',
    failures
  );
  requireNotIncludes(
    source,
    'mcr.microsoft.com/playwright',
    'Setup Playwright runtime must not depend on the MCR Playwright container image.',
    failures
  );

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
    setupPlaywrightRuntimeActionSource,
    turboConfigSource,
    desktopPlaywrightConfigSource,
    playwrightEnvironmentSource,
  ] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(claudeReviewWorkflowPath, 'utf8'),
    readFile(setupMonorepoActionPath, 'utf8'),
    readFile(setupDesktopE2EActionPath, 'utf8'),
    readFile(setupPlaywrightRuntimeActionPath, 'utf8'),
    readFile(turboConfigPath, 'utf8'),
    readFile(desktopPlaywrightConfigPath, 'utf8'),
    readFile(playwrightEnvironmentPath, 'utf8'),
  ]);
  const failures = [
    ...validateWorkflowContracts(source),
    ...validateClaudeReviewWorkflowContracts(claudeReviewWorkflowSource),
    ...validateSetupMonorepoContracts(setupMonorepoActionSource),
    ...validateSetupDesktopE2EContracts(setupDesktopE2EActionSource),
    ...validateSetupPlaywrightRuntimeContracts(setupPlaywrightRuntimeActionSource),
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
