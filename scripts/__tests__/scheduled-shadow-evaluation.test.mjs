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

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/scheduled-shadow-evaluations'
);

function fixture(name) {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8'));
}

function labelledEvaluation({ baseSha, findings, routineId = 'boundary-crash-fuzzer' }) {
  const report = { baseSha, findings, routineId };
  return {
    labels: Object.fromEntries(
      findings.map(({ fingerprint }) => [fingerprint, 'correct/actionable'])
    ),
    report,
    reportId: canonicalReportId(report),
    routineId,
  };
}

describe('externally labelled shadow report evaluation', () => {
  it('rejects caller-fabricated shared report artifact identities', () => {
    const report = {
      baseSha: 'a'.repeat(40),
      findings: [{ fingerprint: 'finding-1' }],
      routineId: 'boundary-crash-fuzzer',
    };
    const evaluation = {
      labels: { 'finding-1': 'correct/actionable' },
      report,
      reportId: canonicalReportId(report),
      routineId: 'boundary-crash-fuzzer',
    };

    assert.doesNotThrow(() => evaluateLabeledReportCorpus([evaluation]));
    for (const invalid of [
      { ...evaluation, reportId: 'caller-invented' },
      { ...evaluation, report: { ...report, baseSha: 'A'.repeat(40) } },
      { ...evaluation, report: { ...report, findings: [] } },
      { ...evaluation, report: { ...report, routineId: 'mutation-gap-hardener' } },
      { ...evaluation, routineId: 'unknown-routine' },
    ]) {
      assert.throws(() => evaluateLabeledReportCorpus([invalid]), /report artifact/u);
    }
  });

  it('rejects repeated shared finding fingerprints across the report corpus', () => {
    const evaluation = (baseSha) => {
      const report = {
        baseSha,
        findings: [{ fingerprint: 'repeated-finding' }],
        routineId: 'boundary-crash-fuzzer',
      };
      return {
        labels: { 'repeated-finding': 'correct/actionable' },
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
