#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
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

function defaultRunLane(lane) {
  const invocation = laneSpawnInvocation(lane);
  return spawnSync(invocation.command, invocation.args, {
    env: process.env,
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
  { log = console.log, logError = console.error, runLane = defaultRunLane } = {}
) {
  assertValidLanes(lanes);

  const failures = [];
  for (const [index, lane] of lanes.entries()) {
    log(`[e2e-lanes] ${lane}: START (${index + 1}/${lanes.length})`);
    const result = runLane(lane);

    if (result.error) {
      const message = result.error instanceof Error ? result.error.message : String(result.error);
      failures.push({ lane, reason: message });
      logError(`[e2e-lanes] ${lane}: FAIL (${message})`);
      continue;
    }
    if (result.signal) {
      failures.push({ lane, reason: `signal ${result.signal}` });
      logError(`[e2e-lanes] ${lane}: FAIL (signal ${result.signal})`);
      continue;
    }
    if (result.status !== 0) {
      const status = result.status ?? 'unknown';
      failures.push({ lane, reason: `status ${status}` });
      logError(`[e2e-lanes] ${lane}: FAIL (status ${status})`);
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
