import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseDoctor, parseKnip } from './collect-pruner-baseline.mjs';

function doctorReport(overrides = {}) {
  return JSON.stringify({
    diagnostics: [],
    directory: '.',
    error: null,
    ok: true,
    projects: [],
    schemaVersion: 1,
    summary: {
      affectedFileCount: 0,
      errorCount: 0,
      score: 100,
      scoreLabel: 'excellent',
      totalDiagnosticCount: 0,
      warningCount: 0,
    },
    version: '0.7.1',
    ...overrides,
  });
}

test('parseDoctor reads a clean scan from the JSON report', () => {
  const result = parseDoctor(doctorReport(), 0);
  assert.equal(result.outcome, 'passed');
  assert.equal(result.errorCount, 0);
  assert.equal(result.incompleteResults, false);
});

test('parseDoctor treats error-severity diagnostics as a findings outcome, not a crash', () => {
  const report = doctorReport({
    summary: {
      affectedFileCount: 2,
      errorCount: 3,
      score: 60,
      scoreLabel: 'needs-work',
      totalDiagnosticCount: 4,
      warningCount: 1,
    },
  });
  // exit 1 is expected here (blocking diagnostics), and must NOT be an error.
  const result = parseDoctor(report, 1);
  assert.equal(result.outcome, 'findings');
  assert.equal(result.errorCount, 3);
  assert.equal(result.warnings, 1);
});

test('parseDoctor surfaces skipped checks as incomplete results', () => {
  const report = doctorReport({
    projects: [{ skippedChecks: ['lint'] }, { skippedChecks: [] }],
  });
  const result = parseDoctor(report, 0);
  assert.equal(result.skippedChecks, 1);
  assert.equal(result.incompleteResults, true);
});

test('parseDoctor fails operationally when the report is ok:false', () => {
  const report = doctorReport({ error: { message: 'boom' }, ok: false });
  assert.throws(() => parseDoctor(report, 1), /failed operationally: boom/);
});

test('parseDoctor fails on non-JSON output rather than degrading silently', () => {
  assert.throws(
    () => parseDoctor('react-doctor crashed before emitting json', 1),
    /parseable JSON report/
  );
});

test('parseDoctor rejects a report missing the summary shape', () => {
  assert.throws(() => parseDoctor(JSON.stringify({ ok: true }), 0), /ok\/summary shape/);
});

test('parseKnip distinguishes findings from operational failure', () => {
  const clean = parseKnip('', 0);
  assert.equal(clean.outcome, 'clean');
  const findings = parseKnip('Unused files (2)\nUnused exports (5)\n', 1);
  assert.equal(findings.outcome, 'findings');
  assert.equal(findings.findingsTotal, 7);
  assert.throws(() => parseKnip('boom', 2), /failed operationally/);
});
