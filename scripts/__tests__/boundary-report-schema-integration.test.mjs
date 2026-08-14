import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOUNDARY_FUZZ_SEED,
  boundaryFindingFingerprint,
  classifyBoundaryRun,
  createDeterministicCaseIds,
  validateBoundaryCrashReport,
} from '../deterministic-boundary-crash-fuzzer.mjs';

const wrap = (classified) => ({
  baseSha: 'a'.repeat(40),
  ...classified,
  routineId: 'boundary-crash-fuzzer',
  seed: BOUNDARY_FUZZ_SEED,
});

test('every timed-out producer count remains valid with unexpected assertions', () => {
  const ids = createDeterministicCaseIds();
  const classified = classifyBoundaryRun({
    expectedCaseIds: ids,
    processResult: { exitCode: null, signal: null, terminationFailed: false, timedOut: true },
    vitestReport: {
      testResults: [
        ...ids.map((title) => ({ assertionResults: [{ status: 'passed', title }] })),
        { assertionResults: [{ status: 'failed', title: 'unexpected-case' }] },
      ],
    },
  });

  assert.deepEqual(classified.counts, {
    executed: ids.length,
    expected: ids.length,
    findings: 0,
    unexpected: 1,
  });
  assert.doesNotThrow(() => validateBoundaryCrashReport(wrap(classified)));
});

test('boundary report rejects producer-impossible assertion statuses', () => {
  const caseId = createDeterministicCaseIds()[0];
  const status = 'invented-vitest-status';
  const report = wrap({
    classification: 'boundary-counterexample',
    counts: { executed: 2048, expected: 2048, findings: 1, unexpected: 0 },
    findings: [
      {
        caseId,
        fingerprint: boundaryFindingFingerprint(caseId, status),
        kind: 'boundary-counterexample',
        status,
      },
    ],
  });

  assert.throws(() => validateBoundaryCrashReport(report), /boundary crash report/u);
});

test('nonzero and duplicate failure runs round-trip only as empty incomplete reports', () => {
  const ids = createDeterministicCaseIds();
  const assertions = ids.map((title, index) => ({
    status: index === 0 ? 'failed' : 'passed',
    title,
  }));
  for (const [exitCode, assertionResults] of [
    [1, assertions],
    [0, [...assertions, assertions[0]]],
  ]) {
    const classified = classifyBoundaryRun({
      expectedCaseIds: ids,
      processResult: { exitCode, signal: null, terminationFailed: false, timedOut: false },
      vitestReport: { testResults: [{ assertionResults }] },
    });
    assert.equal(classified.classification, 'incomplete');
    assert.equal(classified.counts.findings, 0);
    assert.deepEqual(classified.findings, []);
    assert.doesNotThrow(() => validateBoundaryCrashReport(wrap(classified)));
  }
});
