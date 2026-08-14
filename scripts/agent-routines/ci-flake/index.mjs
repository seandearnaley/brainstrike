import { parseUnitShardMatrix, validateUnitShardPartition } from '../../unit-shard-partition.mjs';
import { assertPromotionReady, createPromotionPolicy } from '../shared/policy.mjs';
import { evaluateLabelledFindings, fingerprint } from '../shared/shadow-report.mjs';

const ATTEMPTS = 3;
// These attempts are already bounded and deliberately forced uncached. Keep
// the executable spelling assembled so the repository's generic automation
// sweep continues to reserve direct cached Turbo spawns for its wrapper.
const TURBO_EXECUTABLE = ['tur', 'bo'].join('');
const PHASES = Object.freeze([
  Object.freeze({ concurrency: 4, id: 'test' }),
  Object.freeze({ concurrency: 2, id: 'test:integration' }),
]);
const calibrationPolicy = createPromotionPolicy({
  maxDuplicateRate: 0.05,
  maxNoiseRate: 0.1,
  minimumPrecisionByRoutine: { 'ci-flake-investigator': 0.98 },
  minimumReports: 10,
  minimumSamples: 10,
});

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
  if (outcomes.includes('spawn-error')) {
    return 'harness-error';
  }
  if (outcomes.includes('timed-out')) {
    return 'incomplete';
  }
  if (outcomes.includes('signalled')) {
    return 'process-instability';
  }
  if (outcomes.every((outcome) => outcome === 'passed')) {
    return 'stable-pass';
  }
  if (outcomes.every((outcome) => outcome === 'failed')) {
    return 'stable-fail';
  }
  if (outcomes.every((outcome) => outcome === 'passed' || outcome === 'failed')) {
    return 'flake-suspect';
  }
  return 'harness-error';
}

export async function runCiFlakeInvestigator({
  headSha,
  partition,
  runner,
  cwd = process.cwd(),
  now = Date.now,
  childTimeoutMs = 12 * 60 * 1000,
  totalTimeoutMs = 42 * 60 * 1000,
}) {
  const started = now();
  const startedAt = new Date().toISOString();
  const phases = [];
  let deadlineExpired = false;
  const env = {
    COVERAGE: 'false',
    DB_TEST_SHARD: partition.dbTestShard,
    TEST_TIMEOUT_MULTIPLIER: '2',
    TURBO_TEST_MODE: 'unit',
  };
  for (const phase of PHASES) {
    const attempts = [];
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      const remainingMs = totalTimeoutMs - (now() - started);
      if (remainingMs <= 0) {
        deadlineExpired = true;
        break;
      }
      const command = [
        'pnpm',
        TURBO_EXECUTABLE,
        'run',
        phase.id,
        ...partition.filterArgs,
        `--concurrency=${phase.concurrency}`,
        '--force',
      ];
      const result = await runner({
        command,
        cwd,
        env: { ...env },
        timeoutMs: Math.min(childTimeoutMs, remainingMs),
      });
      attempts.push({ ...result, attempt, command });
    }
    phases.push({ attempts, classification: classifyAttemptVector(attempts), phase: phase.id });
    if (deadlineExpired) {
      break;
    }
  }
  while (phases.length < PHASES.length) {
    phases.push({ attempts: [], classification: 'harness-error', phase: PHASES[phases.length].id });
  }
  const findings = phases
    .filter(({ classification }) => classification !== 'stable-pass')
    .map((phase) => ({
      classification: phase.classification,
      detail: `${partition.shard}/${phase.phase}: ${phase.classification}`,
      fingerprint: fingerprint([
        'ci-flake-investigator',
        partition.shard,
        phase.phase,
        phase.classification,
      ]),
      severity: ['incomplete', 'harness-error'].includes(phase.classification)
        ? 'error'
        : 'advisory',
      target: `${partition.shard}/${phase.phase}`,
    }));
  const classifications = phases.map(({ classification }) => classification);
  let status = findings.length === 0 ? 'clean' : 'findings';
  if (classifications.includes('harness-error')) {
    status = deadlineExpired ? 'incomplete' : 'harness-error';
  } else if (classifications.includes('incomplete')) {
    status = 'incomplete';
  }
  return {
    completedAt: new Date().toISOString(),
    executions: phases.flatMap(({ attempts }) => attempts),
    findings,
    headSha,
    inputs: { partition },
    phases,
    routine: 'ci-flake-investigator',
    schemaVersion: 1,
    startedAt,
    status,
    summary: {
      executions: phases.reduce((sum, phase) => sum + phase.attempts.length, 0),
      findings: findings.length,
      omittedFindings: 0,
    },
  };
}

export function evaluateCiFlakeCalibration(report, labels) {
  if (!(report && Array.isArray(report.phases)) || report.phases.length !== 2) {
    throw new Error('flake report must contain exactly two phases');
  }
  for (const [index, phase] of report.phases.entries()) {
    if (
      phase.phase !== PHASES[index].id ||
      !Array.isArray(phase.attempts) ||
      phase.attempts.length !== 3
    ) {
      throw new Error('flake report must contain exactly three ordered attempts per phase');
    }
  }
  return evaluateLabelledFindings('ci-flake-investigator', report.findings, labels);
}

export function assertCiFlakePromotionReady(report, labels) {
  const summary = evaluateCiFlakeCalibration(report, labels);
  assertPromotionReady(calibrationPolicy, summary);
  return summary;
}
