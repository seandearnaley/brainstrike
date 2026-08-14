import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BOUNDARY_CASE_COUNTS,
  BOUNDARY_FUZZ_SEED,
  boundaryRunExitCode,
  classifyBoundaryRun,
  createDeterministicCaseIds,
} from '../deterministic-boundary-crash-fuzzer.mjs';

describe('deterministic boundary crash fuzzer harness', () => {
  it('uses the fixed seed and produces stable, non-vacuous case identities', () => {
    assert.equal(BOUNDARY_FUZZ_SEED, 0x42_53_54_52);
    assert.deepEqual(BOUNDARY_CASE_COUNTS, {
      parserEnvelope: 256,
      parserSource: 1024,
      path: 512,
      runVerdict: 256,
    });

    const first = createDeterministicCaseIds();
    const second = createDeterministicCaseIds();
    assert.deepEqual(first, second);
    assert.equal(first.length, 2048);
    assert.equal(new Set(first).size, first.length);
  });

  it('classifies a complete successful JSON run as no-change', () => {
    const report = classifyBoundaryRun({
      expectedCaseIds: createDeterministicCaseIds(),
      processResult: { exitCode: 0, signal: null, timedOut: false },
      vitestReport: {
        testResults: createDeterministicCaseIds().map((caseId) => ({
          assertionResults: [
            { ancestorTitles: [], fullName: caseId, status: 'passed', title: caseId },
          ],
          name: 'deterministic-boundary-crash-fuzzer.test.ts',
          status: 'passed',
        })),
      },
    });

    assert.equal(report.classification, 'no-change');
    assert.equal(report.counts.expected, 2048);
    assert.equal(report.counts.executed, 2048);
    assert.deepEqual(report.findings, []);
  });

  it('fails closed for a signal, missing JSON, timeout, or incomplete case set', () => {
    const ids = createDeterministicCaseIds();
    const completeReport = {
      testResults: ids.map((caseId) => ({
        assertionResults: [{ status: 'passed', title: caseId }],
      })),
    };
    const baseProcess = { exitCode: 1, signal: null, timedOut: false };

    assert.equal(
      classifyBoundaryRun({
        expectedCaseIds: ids,
        processResult: { ...baseProcess, signal: 'SIGSEGV' },
        vitestReport: null,
      }).classification,
      'parser-process-crash'
    );
    assert.equal(
      classifyBoundaryRun({ expectedCaseIds: ids, processResult: baseProcess, vitestReport: null })
        .classification,
      'parser-process-crash'
    );
    assert.equal(
      classifyBoundaryRun({
        expectedCaseIds: ids,
        processResult: { ...baseProcess, timedOut: true },
        vitestReport: completeReport,
      }).classification,
      'incomplete'
    );
    assert.equal(
      classifyBoundaryRun({
        expectedCaseIds: ids,
        processResult: baseProcess,
        vitestReport: { testResults: completeReport.testResults.slice(1) },
      }).classification,
      'incomplete'
    );
  });

  it('maps incomplete and harness failures to a nonzero runner exit', () => {
    for (const classification of ['incomplete', 'parser-process-crash', 'harness-error']) {
      assert.equal(boundaryRunExitCode({ classification }), 1);
    }
    assert.equal(boundaryRunExitCode({ classification: 'no-change' }), 0);
    assert.equal(boundaryRunExitCode({ classification: 'boundary-counterexample' }), 0);
  });

  it('rejects duplicate case results instead of letting them mask harness drift', () => {
    const ids = createDeterministicCaseIds();
    const assertionResults = ids.map((caseId) => ({ status: 'passed', title: caseId }));
    assertionResults.push({ status: 'passed', title: ids[0] });

    const report = classifyBoundaryRun({
      expectedCaseIds: ids,
      processResult: { exitCode: 0, signal: null, timedOut: false },
      vitestReport: { testResults: [{ assertionResults }] },
    });

    assert.equal(report.classification, 'incomplete');
  });

  it('caps counterexample detail while preserving complete totals and stable fingerprints', () => {
    const ids = createDeterministicCaseIds();
    const makeReport = () =>
      classifyBoundaryRun({
        expectedCaseIds: ids,
        processResult: { exitCode: 1, signal: null, timedOut: false },
        vitestReport: {
          testResults: [
            {
              assertionResults: ids.map((caseId, index) => ({
                status: index < 125 ? 'failed' : 'passed',
                title: caseId,
              })),
            },
          ],
        },
      });

    const first = makeReport();
    const second = makeReport();
    assert.equal(first.classification, 'boundary-counterexample');
    assert.equal(first.counts.findings, 125);
    assert.equal(first.findings.length, 100);
    assert.deepEqual(first.findings, second.findings);
  });
});
