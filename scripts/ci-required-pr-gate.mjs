#!/usr/bin/env node

export const ALWAYS_REQUIRED_JOBS = ['pr-sentinel', 'checks'];

export const JOBS_BY_LANE = new Map([
  ['ci:unit', ['unit_affected']],
  ['ci:coverage-db', ['unit_coverage']],
  ['ci:coverage-full', ['unit_coverage']],
  ['ci:browser', ['browser-tests']],
  ['ci:web-smoke', ['prepare-web', 'web-e2e-smoke-pr']],
  [
    'ci:web-file-explorer-persistence',
    ['prepare-web', 'web-e2e-file-explorer-persistence-pr'],
  ],
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
]);

function splitCsv(value) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseRequiredPrGateEnv(env = process.env) {
  if (!env.REQUIRED_NEEDS) {
    throw new Error('REQUIRED_NEEDS is required');
  }
  return {
    needs: JSON.parse(env.REQUIRED_NEEDS),
    requiredLabels: splitCsv(env.REQUIRED_LABELS ?? ''),
    requiredLanes: splitCsv(env.REQUIRED_EXPANDED_LANES ?? ''),
  };
}

export function verifyRequiredPrGate({ needs, requiredLabels, requiredLanes }) {
  const failures = [];

  for (const jobName of ALWAYS_REQUIRED_JOBS) {
    if (needs[jobName]?.result !== 'success') {
      failures.push(`${jobName}: ${needs[jobName]?.result ?? 'missing'}`);
    }
  }

  for (const [name, job] of Object.entries(needs)) {
    if (
      job.result === 'failure' ||
      job.result === 'cancelled' ||
      job.result === 'timed_out'
    ) {
      failures.push(`${name}: ${job.result}`);
    }
  }

  // Labels are the human-facing contract, but expanded lanes are the actual
  // job contract. A selected label with no lanes means Sentinel failed to
  // expand the risk selection, which must never become a green no-op gate.
  if (requiredLabels.length > 0 && requiredLanes.length === 0) {
    failures.push(
      `PR Sentinel selected labels ${requiredLabels.join(',')} but produced no expanded lanes`
    );
  }

  for (const lane of requiredLanes) {
    const jobs = JOBS_BY_LANE.get(lane);
    if (!jobs) {
      failures.push(`expanded lane ${lane} has no Required PR Gate job mapping`);
      continue;
    }
    for (const jobName of jobs) {
      if (needs[jobName]?.result !== 'success') {
        failures.push(
          `${lane} requires ${jobName}, got ${needs[jobName]?.result ?? 'missing'}`
        );
      }
    }
  }

  return failures;
}

export function runRequiredPrGate(env = process.env) {
  const failures = verifyRequiredPrGate(parseRequiredPrGateEnv(env));
  if (failures.length > 0) {
    console.error('Required PR gate failed:');
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    return 1;
  }
  console.log('Required PR gate passed.');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = runRequiredPrGate();
}
