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

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/scheduled-shadow-evaluations'
);

function fixture(name) {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8'));
}

describe('externally labelled shadow report evaluation', () => {
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
    const oneReportWithTenFindings = {
      labels: Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [`finding-${index}`, 'correct/actionable'])
      ),
      report: {
        findings: Array.from({ length: 10 }, (_, index) => ({
          fingerprint: `finding-${index}`,
        })),
      },
      reportId: 'one-report',
      routineId: 'boundary-crash-fuzzer',
    };
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

    const tenReportCases = Array.from({ length: 10 }, (_, index) => ({
      labels: { [`finding-${index}`]: 'correct/actionable' },
      report: { findings: [{ fingerprint: `finding-${index}` }] },
      reportId: `report-${index}`,
      routineId: 'boundary-crash-fuzzer',
    }));
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
