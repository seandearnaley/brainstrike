import { parseUnitShardMatrix, validateUnitShardPartition } from '../../unit-shard-partition.mjs';
import { fingerprint } from '../shared/shadow-report.mjs';

const ATTEMPTS = 3;
const TURBO_EXECUTABLE = ['tur', 'bo'].join('');
const PHASE_STEPS = new Map([
  ['Push and manual unit tests', Object.freeze({ concurrency: 4, id: 'test' })],
  ['Push and manual integration tests', Object.freeze({ concurrency: 2, id: 'test:integration' })],
]);
const UNIT_JOB_PATTERN = /^Unit \((db-1|db-2|heavy|rest)\)$/u;

export function loadUnitPartition(workflowText, shard) {
  const matrix = parseUnitShardMatrix(workflowText);
  const failures = validateUnitShardPartition(matrix);
  if (failures.length > 0) {
    throw new Error(`live Unit partition is invalid: ${failures.join('; ')}`);
  }
  const row = matrix.find((entry) => entry.shard === shard);
  if (!row) {
    throw new Error(`unknown live Unit shard: ${shard}`);
  }
  return Object.freeze({
    dbTestShard: row.vitestShard ? `${row.vitestShard.index}/${row.vitestShard.count}` : '',
    filterArgs: Object.freeze([...row.push.tokens]),
    partition: row.partition,
    shard: row.shard,
  });
}

export function classifyAttemptVector(attempts) {
  if (!Array.isArray(attempts) || attempts.length !== ATTEMPTS) {
    return 'harness-error';
  }
  const outcomes = attempts.map(({ outcome }) => outcome);
  if (outcomes.some((outcome) => !['passed', 'failed'].includes(outcome))) {
    return 'infrastructure';
  }
  if (outcomes.every((outcome) => outcome === 'passed')) {
    return 'stable-pass';
  }
  if (outcomes.every((outcome) => outcome === 'failed')) {
    return 'stable-fail';
  }
  return 'flake-suspect';
}

export function selectQualifyingUnitFailure({ baseSha, jobs, runs }) {
  if (!(Array.isArray(runs) && Array.isArray(jobs))) {
    return null;
  }
  const qualifyingRuns = runs.filter(
    (run) =>
      run?.name === 'Test' &&
      run.status === 'completed' &&
      run.conclusion === 'failure' &&
      run.event === 'push' &&
      run.head_branch === 'main' &&
      run.head_sha === baseSha &&
      Number.isSafeInteger(run.id)
  );
  if (qualifyingRuns.length !== 1) {
    return null;
  }
  const run = qualifyingRuns[0];
  const candidates = [];
  for (const job of jobs) {
    const match = typeof job?.name === 'string' ? UNIT_JOB_PATTERN.exec(job.name) : null;
    if (
      !match ||
      job.status !== 'completed' ||
      job.conclusion !== 'failure' ||
      !Number.isSafeInteger(job.id) ||
      !Array.isArray(job.steps)
    ) {
      continue;
    }
    const failedSteps = job.steps.filter(({ conclusion }) => conclusion === 'failure');
    if (failedSteps.length !== 1) {
      continue;
    }
    const phase = PHASE_STEPS.get(failedSteps[0].name);
    if (!phase) {
      continue;
    }
    candidates.push({
      jobId: job.id,
      phase: phase.id,
      runId: run.id,
      runUrl: run.html_url,
      shard: match[1],
    });
  }
  return candidates.length === 1 ? Object.freeze(candidates[0]) : null;
}

export async function runCiFlakeInvestigator({
  baseSha,
  candidate,
  runner,
  workflowText,
  cwd = process.cwd(),
  now = Date.now,
  childTimeoutMs = 12 * 60 * 1000,
  totalTimeoutMs = 38 * 60 * 1000,
}) {
  const started = now();
  const startedAt = new Date().toISOString();
  if (candidate === null) {
    return {
      baseSha,
      classification: 'no-qualifying-failure',
      completedAt: new Date().toISOString(),
      executions: [],
      findings: [],
      routine: 'ci-flake-investigator',
      schemaVersion: 2,
      selected: null,
      startedAt,
      status: 'clean',
      summary: { executions: 0, findings: 0, omittedFindings: 0 },
    };
  }

  const partition = loadUnitPartition(workflowText, candidate.shard);
  const phase = [...PHASE_STEPS.values()].find(({ id }) => id === candidate.phase);
  if (!phase) {
    throw new Error(`unsupported selected Unit phase: ${String(candidate.phase)}`);
  }
  const env = {
    COVERAGE: 'false',
    DB_TEST_SHARD: partition.dbTestShard,
    TEST_TIMEOUT_MULTIPLIER: '2',
    TURBO_TEST_MODE: 'unit',
  };
  const attempts = [];
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const remainingMs = totalTimeoutMs - (now() - started);
    if (remainingMs <= 0) {
      break;
    }
    const command = [
      'pnpm',
      TURBO_EXECUTABLE,
      'run',
      phase.id,
      ...partition.filterArgs,
      `--concurrency=${phase.concurrency}`,
      '--cache=local:r',
    ];
    const result = await runner({
      command,
      cwd,
      env: { ...env },
      timeoutMs: Math.min(childTimeoutMs, remainingMs),
    });
    attempts.push({ ...result, attempt, command });
  }
  const classification = classifyAttemptVector(attempts);
  const isFinding = ['flake-suspect', 'stable-fail'].includes(classification);
  const finding = isFinding
    ? {
        classification,
        detail: `${candidate.shard}/${candidate.phase}: ${classification}`,
        fingerprint: fingerprint([
          'ci-flake-investigator',
          baseSha,
          String(candidate.runId),
          candidate.shard,
          candidate.phase,
          classification,
        ]),
        severity: 'advisory',
        target: `${candidate.shard}/${candidate.phase}`,
      }
    : null;
  const findings = finding ? [finding] : [];
  const status = ['harness-error', 'infrastructure'].includes(classification)
    ? 'incomplete'
    : findings.length > 0
      ? 'findings'
      : 'clean';
  return {
    baseSha,
    classification,
    completedAt: new Date().toISOString(),
    executions: attempts,
    findings,
    inputs: { partition },
    routine: 'ci-flake-investigator',
    schemaVersion: 2,
    selected: { ...candidate },
    startedAt,
    status,
    summary: { executions: attempts.length, findings: findings.length, omittedFindings: 0 },
  };
}
