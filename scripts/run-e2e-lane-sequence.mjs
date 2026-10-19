#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSpawnInvocation } from './spawn-command.mjs';

const LANE_PREFIX = 'test:e2e:lane:';
const LANE_NAME_PATTERN = /^test:e2e:lane:[a-z0-9]+(?:-[a-z0-9]+)*$/;

function assertValidLaneName(lane) {
  if (typeof lane !== 'string' || !LANE_NAME_PATTERN.test(lane)) {
    throw new Error(`Invalid E2E lane script name: ${String(lane)}`);
  }
}

export function laneCommandArguments(lane) {
  assertValidLaneName(lane);

  const outputDirectory = `test-results/${lane.slice(LANE_PREFIX.length)}`;
  return ['run', lane, `--output=${outputDirectory}`];
}

export function laneSpawnInvocation(lane, platform = process.platform) {
  return createSpawnInvocation('pnpm', laneCommandArguments(lane), platform);
}

/**
 * A lane's environment. Playwright writes one JSON report per run, so with
 * PLAYWRIGHT_JSON_OUTPUT_DIR set each lane writes its own <lane>.json there
 * (BST-2189); one PLAYWRIGHT_JSON_OUTPUT_FILE would keep only the last lane's.
 */
function laneReportPath(lane, env, extension) {
  const reportDirectory = env.PLAYWRIGHT_JSON_OUTPUT_DIR;
  return reportDirectory
    ? path.join(reportDirectory, `${lane.slice(LANE_PREFIX.length)}${extension}`)
    : undefined;
}

export function laneEnvironment(lane, env) {
  assertValidLaneName(lane);
  if (env.PLAYWRIGHT_JSON_OUTPUT_FILE) {
    throw new Error(
      'PLAYWRIGHT_JSON_OUTPUT_FILE would hold only the last lane; set PLAYWRIGHT_JSON_OUTPUT_DIR.'
    );
  }
  const reportFile = laneReportPath(lane, env, '.json');
  return reportFile ? { ...env, PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile } : env;
}

/**
 * A failed lane that left no JSON report would leave the nightly notifier
 * nothing to file for it, hidden behind any other lane's failing test. Record
 * how it failed as <lane>.unreported beside the reports (BST-2189).
 */
export function recordUnreportedLane(lane, how, env) {
  const reportFile = laneReportPath(lane, env, '.json');
  if (reportFile && !existsSync(reportFile)) {
    writeFileSync(laneReportPath(lane, env, '.unreported'), `${how}\n`);
  }
}

function defaultRunLane(lane) {
  const invocation = laneSpawnInvocation(lane);
  return spawnSync(invocation.command, invocation.args, {
    env: laneEnvironment(lane, process.env),
    shell: invocation.shell,
    stdio: 'inherit',
  });
}

function assertValidLanes(lanes) {
  if (!Array.isArray(lanes) || lanes.length === 0) {
    throw new Error('Expected at least one E2E lane script name.');
  }

  const seen = new Set();
  for (const lane of lanes) {
    assertValidLaneName(lane);
    if (seen.has(lane)) {
      throw new Error(`Duplicate E2E lane script name: ${lane}`);
    }
    seen.add(lane);
  }
}

export function runE2eLaneSequence(
  lanes,
  { env = process.env, log = console.log, logError = console.error, runLane = defaultRunLane } = {}
) {
  assertValidLanes(lanes);

  const failures = [];
  const fail = (lane, reason, how) => {
    failures.push({ lane, reason });
    logError(`[e2e-lanes] ${lane}: FAIL (${reason})`);
    recordUnreportedLane(lane, how, env);
  };
  for (const [index, lane] of lanes.entries()) {
    log(`[e2e-lanes] ${lane}: START (${index + 1}/${lanes.length})`);
    const result = runLane(lane);

    if (result.error) {
      const message = result.error instanceof Error ? result.error.message : String(result.error);
      fail(lane, message, `failed to start (${message})`);
      continue;
    }
    if (result.signal) {
      fail(lane, `signal ${result.signal}`, `was killed by ${result.signal}`);
      continue;
    }
    if (result.status !== 0) {
      const status = result.status ?? 'unknown';
      fail(lane, `status ${status}`, `exited ${status}`);
      continue;
    }

    log(`[e2e-lanes] ${lane}: PASS`);
  }

  if (failures.length === 0) {
    log(`[e2e-lanes] PASS: all ${lanes.length} lanes completed successfully.`);
    return 0;
  }

  logError(
    `[e2e-lanes] FAIL: ${failures.length}/${lanes.length} lanes failed: ${failures
      .map(({ lane, reason }) => `${lane} (${reason})`)
      .join(', ')}`
  );
  return 1;
}

const isDirectExecution =
  process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  try {
    process.exitCode = runE2eLaneSequence(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
