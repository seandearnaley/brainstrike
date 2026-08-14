import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createReport,
  validateModelCatalogReport,
} from '../agent-routines/model-catalog/report.mjs';

test('model report rejects producer-impossible safety dispositions', () => {
  const report = createReport({
    baseCommit: 'a'.repeat(40),
    deltas: [
      {
        kind: 'aligned',
        modelId: 'model-1',
        providerId: 'provider-1',
        safety: { disposition: 'report_only', reasons: [] },
      },
    ],
    generatedAt: '2026-08-14T00:00:00.000Z',
    manifestSha256: `sha256:${'1'.repeat(64)}`,
    registry: { models: [{}], providerCounts: { 'provider-1': 1 } },
    sources: [{ required: true, sourceId: 'source-1', status: 'success' }],
  });
  const impossible = {
    ...report,
    deltas: [
      {
        ...report.deltas[0],
        safety: { disposition: 'safe_addition', reasons: [] },
      },
    ],
    summary: { ...report.summary, safeAdditions: 1 },
  };

  assert.throws(() => validateModelCatalogReport(impossible), /model catalog report/u);
});
