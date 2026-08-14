import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertLabeledReportPromotionReady,
  evaluateExternallyLabeledReport,
} from '../agent-routines/shared/evaluation.mjs';
import { createPromotionPolicy } from '../agent-routines/shared/policy.mjs';

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
    const policy = createPromotionPolicy({
      maxDuplicateRate: 0.5,
      maxNoiseRate: 0.5,
      minimumPrecisionByRoutine: { 'boundary-crash-fuzzer': 0.5 },
      minimumSamples: 4,
    });

    assert.doesNotThrow(() => assertLabeledReportPromotionReady(policy, holdout));
    delete holdout.labels[holdout.report.findings[0].fingerprint];
    assert.throws(
      () => assertLabeledReportPromotionReady(policy, holdout),
      /missing external label/u
    );
  });
});
