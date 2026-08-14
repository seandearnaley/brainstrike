import { assertPromotionReady } from '../shared/policy.mjs';

const LABELS = new Set(['ambiguous', 'correct_actionable', 'duplicate_noise', 'unsafe']);
export function evaluateLabelledReports(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('missing external labels');
  }
  for (const record of records) {
    if (!record || typeof record.findingId !== 'string' || !LABELS.has(record.label)) {
      throw new Error(`missing external label for finding: ${record?.findingId ?? 'unknown'}`);
    }
  }
  const count = (label) => records.filter((record) => record.label === label).length;
  const sampleCount = records.length;
  const duplicate = count('duplicate_noise');
  const unsafe = count('unsafe');
  const correct = count('correct_actionable');
  return {
    criticalFalsePositives: unsafe,
    duplicateRate: duplicate / sampleCount,
    noiseRate: duplicate / sampleCount,
    precision: correct / sampleCount,
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
