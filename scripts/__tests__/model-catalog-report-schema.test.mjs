import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('model report admits only producer-shaped nested evidence', () => {
  const value = 'provider/model-1';
  const evidence = {
    authority: 'route',
    freshness: 'live',
    jsonPointer: '/data/0/id',
    rawValueSha256: `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`,
    retrievedAt: '2026-08-14T00:00:00.000Z',
    sourceId: 'openrouter-models',
    sourceModelId: value,
    sourceUrl: 'https://openrouter.ai/api/v1/models',
    value,
  };
  const report = createReport({
    baseCommit: 'b'.repeat(40),
    deltas: [
      {
        evidence: { id: { evidence: [evidence], status: 'resolved', value } },
        kind: 'remote_addition_candidate',
        modelId: value,
        providerId: 'provider-1',
        safety: { disposition: 'report_only', reasons: ['candidate'] },
      },
    ],
    generatedAt: '2026-08-14T00:00:00.000Z',
    manifestSha256: `sha256:${'2'.repeat(64)}`,
    registry: { models: [{}], providerCounts: { 'provider-1': 1 } },
    sources: [{ required: true, sourceId: 'openrouter-models', status: 'success' }],
  });

  assert.doesNotThrow(() => validateModelCatalogReport(report));
  const invalidEvidence = [
    'producer-impossible',
    { ...report.deltas[0].evidence, inventedField: report.deltas[0].evidence.id },
    {
      ...report.deltas[0].evidence,
      id: { ...report.deltas[0].evidence.id, value: 'different-value' },
    },
    {
      ...report.deltas[0].evidence,
      id: {
        ...report.deltas[0].evidence.id,
        evidence: [{ ...evidence, sourceId: 'absent-source' }],
      },
    },
    {
      ...report.deltas[0].evidence,
      id: {
        ...report.deltas[0].evidence.id,
        evidence: [{ ...evidence, retrievedAt: '2026-08-15T00:00:00.000Z' }],
      },
    },
  ];
  for (const candidate of invalidEvidence) {
    assert.throws(
      () =>
        validateModelCatalogReport({
          ...report,
          deltas: [{ ...report.deltas[0], evidence: candidate }],
        }),
      /model catalog report/u
    );
  }
});
