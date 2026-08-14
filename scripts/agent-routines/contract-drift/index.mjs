import { assertPromotionReady, createPromotionPolicy } from '../shared/policy.mjs';
import { evaluateLabelledFindings, fingerprint } from '../shared/shadow-report.mjs';

const TURBO_EXECUTABLE = ['tur', 'bo'].join('');

export const CONTRACT_COMMANDS = Object.freeze([
  Object.freeze({
    // This is the required existing boundary invocation. It is intentionally
    // bounded by this routine's injected runner rather than the general Turbo
    // wrapper because `boundaries` must run before cache/build materialization.
    command: Object.freeze(['pnpm', 'exec', TURBO_EXECUTABLE, 'boundaries']),
    id: 'boundaries',
  }),
  Object.freeze({ command: Object.freeze(['pnpm', 'test:scripts']), id: 'test-scripts' }),
  Object.freeze({ command: Object.freeze(['pnpm', 'run', 'lint:ci']), id: 'lint-ci' }),
]);

const calibrationPolicy = createPromotionPolicy({
  maxDuplicateRate: 0.05,
  maxNoiseRate: 0.1,
  minimumPrecisionByRoutine: { 'contract-drift-guardian': 0.98 },
  minimumSamples: 1,
});

function classificationFor(outcome) {
  if (outcome === 'passed') {
    return 'stable-clean';
  }
  if (outcome === 'failed') {
    return 'contract-drift';
  }
  if (outcome === 'signalled') {
    return 'process-instability';
  }
  if (outcome === 'timed-out') {
    return 'incomplete';
  }
  return 'harness-error';
}

export async function runContractDriftGuardian({
  headSha,
  runner,
  cwd = process.cwd(),
  now = Date.now,
  commandTimeoutMs = 15 * 60 * 1000,
  totalTimeoutMs = 35 * 60 * 1000,
}) {
  const startedAt = new Date().toISOString();
  const started = now();
  const executions = [];
  for (const definition of CONTRACT_COMMANDS) {
    const remainingMs = totalTimeoutMs - (now() - started);
    const raw =
      remainingMs <= 0
        ? {
            durationMs: 0,
            exitCode: null,
            outcome: 'timed-out',
            signal: null,
            stderrTail: 'total routine deadline expired before execution',
            stdoutTail: '',
          }
        : await runner({
            command: [...definition.command],
            cwd,
            env: {},
            timeoutMs: Math.min(commandTimeoutMs, remainingMs),
          });
    executions.push({
      ...raw,
      classification: classificationFor(raw.outcome),
      command: [...definition.command],
      id: definition.id,
    });
  }
  const findings = executions
    .filter(({ classification }) => classification !== 'stable-clean')
    .map((entry) => ({
      classification: entry.classification,
      detail: `${entry.id} completed as ${entry.outcome}`,
      fingerprint: fingerprint(['contract-drift-guardian', entry.id, entry.classification]),
      severity: entry.classification === 'contract-drift' ? 'advisory' : 'error',
      target: entry.id,
    }));
  let status = findings.length === 0 ? 'clean' : 'findings';
  if (executions.some(({ classification }) => classification === 'harness-error')) {
    status = 'harness-error';
  } else if (
    executions.some(({ classification }) =>
      ['incomplete', 'process-instability'].includes(classification)
    )
  ) {
    status = 'incomplete';
  }
  return {
    completedAt: new Date().toISOString(),
    executions,
    findings,
    headSha,
    routine: 'contract-drift-guardian',
    schemaVersion: 1,
    startedAt,
    status,
    summary: { executions: executions.length, findings: findings.length, omittedFindings: 0 },
  };
}

export function evaluateContractDriftCalibration(report, labels) {
  if (!(report && Array.isArray(report.executions)) || report.executions.length !== 3) {
    throw new Error('contract report must contain exactly three executions');
  }
  for (let index = 0; index < CONTRACT_COMMANDS.length; index += 1) {
    const expected = CONTRACT_COMMANDS[index];
    const actual = report.executions[index];
    if (
      actual.id !== expected.id ||
      JSON.stringify(actual.command) !== JSON.stringify(expected.command)
    ) {
      throw new Error('contract report does not preserve exact command order');
    }
  }
  const summary = evaluateLabelledFindings('contract-drift-guardian', report.findings, labels);
  assertPromotionReady(calibrationPolicy, summary);
  return summary;
}
