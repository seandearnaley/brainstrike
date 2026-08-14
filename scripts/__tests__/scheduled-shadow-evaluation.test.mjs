import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertLabeledReportCorpusPromotionReady,
  assertLabeledReportPromotionReady,
  evaluateExternallyLabeledReport,
  evaluateLabeledReportCorpus,
  SHADOW_PROMOTION_POLICIES,
} from '../agent-routines/shared/evaluation.mjs';
import { canonicalReportId } from '../agent-routines/shared/shadow-report.mjs';
import {
  BOUNDARY_FUZZ_SEED,
  boundaryFindingFingerprint,
  createDeterministicCaseIds,
  validateBoundaryCrashReport,
} from '../deterministic-boundary-crash-fuzzer.mjs';
import {
  classifyMutationReport,
  MUTATION_TARGET,
  validateMutationGapReport,
} from '../mutation-gap-hardener.mjs';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/scheduled-shadow-evaluations'
);

function fixture(name) {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8'));
}

function boundaryReport(baseSha = 'a'.repeat(40)) {
  const caseId = createDeterministicCaseIds()[0];
  const status = 'failed';
  return {
    baseSha,
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
    routineId: 'boundary-crash-fuzzer',
    seed: BOUNDARY_FUZZ_SEED,
  };
}

function mutationReport(baseSha = 'b'.repeat(40)) {
  const classified = classifyMutationReport({
    files: {
      [MUTATION_TARGET]: {
        mutants: [
          {
            id: '1',
            location: {
              end: { column: 3, line: 7 },
              start: { column: 1, line: 7 },
            },
            mutatorName: 'EqualityOperator',
            replacement: 'false',
            status: 'Survived',
          },
        ],
      },
    },
  });
  return { baseSha, routineId: 'mutation-gap-hardener', ...classified };
}

function labelledEvaluation({ baseSha, findings, routineId = 'boundary-crash-fuzzer' }) {
  const reportFindings = findings.map((_, index) => {
    const caseId = createDeterministicCaseIds()[index];
    const status = `failed-${baseSha}-${index}`;
    return {
      caseId,
      fingerprint: boundaryFindingFingerprint(caseId, status),
      kind: 'boundary-counterexample',
      status,
    };
  });
  const report = {
    ...boundaryReport(baseSha),
    counts: { executed: 2048, expected: 2048, findings: reportFindings.length, unexpected: 0 },
    findings: reportFindings,
  };
  return {
    labels: Object.fromEntries(
      reportFindings.map(({ fingerprint }) => [fingerprint, 'correct/actionable'])
    ),
    report,
    reportId: canonicalReportId(report),
    routineId,
  };
}

describe('externally labelled shadow report evaluation', () => {
  it('validates the exact boundary crash producer report schema', () => {
    const report = boundaryReport();
    assert.doesNotThrow(() => validateBoundaryCrashReport(report));

    for (const invalid of [
      { ...report, invented: true },
      { ...report, baseSha: 'A'.repeat(40) },
      { ...report, routineId: 'mutation-gap-hardener' },
      { ...report, seed: BOUNDARY_FUZZ_SEED + 1 },
      { ...report, classification: 'invented' },
      { ...report, counts: { ...report.counts, executed: 2047 } },
      { ...report, counts: { ...report.counts, findings: 2 } },
      { ...report, findings: [{ ...report.findings[0], invented: true }] },
      { ...report, findings: [{ ...report.findings[0], caseId: 'invented' }] },
      { ...report, findings: [{ ...report.findings[0], fingerprint: 'short' }] },
    ]) {
      assert.throws(() => validateBoundaryCrashReport(invalid), /boundary crash report/u);
    }
  });

  it('validates the exact mutation gap producer report schema', () => {
    const report = mutationReport();
    assert.doesNotThrow(() => validateMutationGapReport(report));

    for (const invalid of [
      { ...report, invented: true },
      { ...report, baseSha: 'short' },
      { ...report, routineId: 'boundary-crash-fuzzer' },
      { ...report, classification: 'invented' },
      { ...report, totals: { ...report.totals, total: 2 } },
      { ...report, totals: { ...report.totals, survivingMutant: 2 } },
      { ...report, findings: [{ ...report.findings[0], invented: true }] },
      { ...report, findings: [{ ...report.findings[0], file: 'other.ts' }] },
      { ...report, findings: [{ ...report.findings[0], fingerprint: '0'.repeat(64) }] },
      { ...report, findings: [{ ...report.findings[0], kind: 'invented' }] },
      {
        ...report,
        findings: [
          {
            ...report.findings[0],
            location: { ...report.findings[0].location, invented: true },
          },
        ],
      },
      { ...report, reasons: ['not relevant'] },
    ]) {
      assert.throws(() => validateMutationGapReport(invalid), /mutation gap report/u);
    }
  });

  it('canonical report IDs reject every non-JSON in-memory value', () => {
    const cyclic = {};
    cyclic.self = cyclic;
    const sparse = [];
    sparse.length = 1;
    const symbolKeyed = { valid: true };
    symbolKeyed[Symbol('hidden')] = true;
    const accessorArray = [];
    Object.defineProperty(accessorArray, '0', {
      configurable: true,
      enumerable: true,
      get: () => 'not JSON data',
    });
    accessorArray.length = 1;
    const nonEnumerableArray = ['hidden'];
    Object.defineProperty(nonEnumerableArray, '0', { enumerable: false });

    for (const value of [
      undefined,
      { nested: undefined },
      [undefined],
      sparse,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1n,
      Symbol('value'),
      () => {},
      cyclic,
      new Date(0),
      new Map(),
      Object.create(null),
      symbolKeyed,
      accessorArray,
      nonEnumerableArray,
    ]) {
      assert.throws(() => canonicalReportId(value), /canonical JSON/u);
    }
  });

  it('canonical report IDs sort object keys but preserve array order', () => {
    assert.equal(canonicalReportId({ a: 1, b: 2 }), canonicalReportId({ a: 1, b: 2 }));
    assert.notEqual(canonicalReportId([1, 2]), canonicalReportId([2, 1]));
  });

  it('rejects canonically rehashed reports outside the boundary producer schema', () => {
    const report = boundaryReport();
    const evaluationFor = (candidate) => ({
      labels: Object.fromEntries(
        candidate.findings.map(({ fingerprint }) => [fingerprint, 'correct/actionable'])
      ),
      report: candidate,
      reportId: canonicalReportId(candidate),
      routineId: 'boundary-crash-fuzzer',
    });
    const evaluation = evaluationFor(report);

    assert.doesNotThrow(() => evaluateLabeledReportCorpus([evaluation]));
    for (const invalid of [
      { ...evaluation, reportId: 'caller-invented' },
      evaluationFor({ ...report, invented: true }),
      evaluationFor({
        ...report,
        findings: [{ ...report.findings[0], kind: 'invented' }],
      }),
      { ...evaluation, report: { ...report, baseSha: 'A'.repeat(40) } },
      { ...evaluation, report: { ...report, findings: [] } },
      { ...evaluation, report: { ...report, routineId: 'mutation-gap-hardener' } },
      { ...evaluation, routineId: 'unknown-routine' },
    ]) {
      assert.throws(() => evaluateLabeledReportCorpus([invalid]), /report artifact/u);
    }
  });

  it('rejects canonically rehashed reports outside the mutation producer schema', () => {
    const report = mutationReport();
    const evaluationFor = (candidate) => ({
      labels: Object.fromEntries(
        candidate.findings.map(({ fingerprint }) => [fingerprint, 'correct/actionable'])
      ),
      report: candidate,
      reportId: canonicalReportId(candidate),
      routineId: 'mutation-gap-hardener',
    });

    assert.doesNotThrow(() => evaluateLabeledReportCorpus([evaluationFor(report)]));
    for (const invalid of [
      { ...report, invented: true },
      { ...report, findings: [{ ...report.findings[0], kind: 'invented' }] },
      { ...report, totals: { ...report.totals, total: 2 } },
    ]) {
      assert.throws(
        () => evaluateLabeledReportCorpus([evaluationFor(invalid)]),
        /report artifact/u
      );
    }
  });

  it('rejects repeated shared finding fingerprints across the report corpus', () => {
    const evaluation = (baseSha) => {
      const report = boundaryReport(baseSha);
      const sharedFingerprint = report.findings[0].fingerprint;
      return {
        labels: { [sharedFingerprint]: 'correct/actionable' },
        report,
        reportId: canonicalReportId(report),
        routineId: report.routineId,
      };
    };

    assert.throws(
      () => evaluateLabeledReportCorpus([evaluation('a'.repeat(40)), evaluation('b'.repeat(40))]),
      /shared finding fingerprints/u
    );
  });

  it('evaluates holdout labels independently of routine output', () => {
    for (const name of ['boundary-crash-fuzzer.json', 'mutation-gap-hardener.json']) {
      const holdout = fixture(name);
      const summary = evaluateExternallyLabeledReport(holdout);
      assert.deepEqual(summary, holdout.expectedSummary);
    }
  });

  it('fails closed when a finding lacks an external label', () => {
    const holdout = fixture('mutation-gap-hardener.json');
    delete holdout.labels[holdout.report.findings[0].fingerprint];
    assert.throws(() => evaluateExternallyLabeledReport(holdout), /missing external label/u);
  });

  it('feeds external evaluation through shared promotion readiness', () => {
    const holdout = fixture('boundary-crash-fuzzer.json');
    const policy = SHADOW_PROMOTION_POLICIES['boundary-crash-fuzzer'];

    assert.throws(() => assertLabeledReportPromotionReady(policy, holdout), /not promotion-ready/u);
    delete holdout.labels[holdout.report.findings[0].fingerprint];
    assert.throws(
      () => assertLabeledReportPromotionReady(policy, holdout),
      /missing external label/u
    );
  });

  it('derives the promotion report floor from distinct non-empty report IDs', () => {
    const oneReportWithTenFindings = labelledEvaluation({
      baseSha: 'a'.repeat(40),
      findings: Array.from({ length: 10 }, (_, index) => ({
        fingerprint: `finding-${index}`,
      })),
    });
    const oneReport = evaluateLabeledReportCorpus([oneReportWithTenFindings]);
    assert.equal(oneReport.reportCount, 1);
    assert.throws(
      () =>
        assertLabeledReportCorpusPromotionReady(
          SHADOW_PROMOTION_POLICIES['boundary-crash-fuzzer'],
          [oneReportWithTenFindings]
        ),
      /not promotion-ready/u
    );

    const tenReportCases = Array.from({ length: 10 }, (_, index) =>
      labelledEvaluation({
        baseSha: index.toString(16).padStart(40, '0'),
        findings: [{ fingerprint: `finding-${index}` }],
      })
    );
    const tenReports = evaluateLabeledReportCorpus(tenReportCases);
    assert.equal(tenReports.reportCount, 10);
    assert.doesNotThrow(() =>
      assertLabeledReportCorpusPromotionReady(
        SHADOW_PROMOTION_POLICIES['boundary-crash-fuzzer'],
        tenReportCases
      )
    );
  });
});
