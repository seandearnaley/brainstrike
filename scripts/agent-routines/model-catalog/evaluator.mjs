import { assertPromotionReady, createPromotionPolicy } from '../shared/policy.mjs';

const LABELS = new Set(['ambiguous', 'correct_actionable', 'duplicate_noise', 'unsafe']);
export const MODEL_CATALOG_PROMOTION_POLICY = createPromotionPolicy({
  maxDuplicateRate: 0.1,
  maxNoiseRate: 0.1,
  minimumPrecisionByRoutine: { 'model-catalog-updater': 1 },
  minimumReports: 10,
  minimumSamples: 10,
});
export function evaluateLabelledReports(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('missing external labels');
  }
  for (const record of records) {
    if (
      !record ||
      typeof record.findingId !== 'string' ||
      typeof record.reportId !== 'string' ||
      record.reportId.length === 0 ||
      !LABELS.has(record.label)
    ) {
      throw new Error(`missing external label for finding: ${record?.findingId ?? 'unknown'}`);
    }
  }
  const count = (label) => records.filter((record) => record.label === label).length;
  const sampleCount = records.length;
  const duplicate = count('duplicate_noise');
  const unsafe = count('unsafe');
  const correct = count('correct_actionable');
  const reportCount = new Set(records.map(({ reportId }) => reportId)).size;
  return {
    criticalFalsePositives: unsafe,
    duplicateRate: duplicate / sampleCount,
    noiseRate: duplicate / sampleCount,
    precision: correct / sampleCount,
    reportCount,
    routineId: 'model-catalog-updater',
    sampleCount,
    unsafeFindings: unsafe,
  };
}
export function assertLabelledReportsPromotionReady(policy, records) {
  const summary = evaluateLabelledReports(records);
  assertPromotionReady(policy, summary);
  return summary;
}
