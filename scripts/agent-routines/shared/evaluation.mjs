import { assertPromotionReady, createPromotionPolicy } from './policy.mjs';

const EXTERNAL_LABELS = new Set(['correct/actionable', 'duplicate/noise', 'ambiguous', 'unsafe']);
export const SHADOW_PROMOTION_POLICIES = Object.freeze(
  Object.fromEntries(
    ['boundary-crash-fuzzer', 'mutation-gap-hardener'].map((routineId) => [
      routineId,
      createPromotionPolicy({
        maxDuplicateRate: 0.1,
        maxNoiseRate: 0.1,
        minimumPrecisionByRoutine: { [routineId]: 0.9 },
        minimumReports: 10,
        minimumSamples: 10,
      }),
    ])
  )
);

export function evaluateExternallyLabeledReport({ labels, report, routineId }) {
  if (
    typeof routineId !== 'string' ||
    routineId.length === 0 ||
    !report ||
    typeof report !== 'object' ||
    !Array.isArray(report.findings) ||
    !labels ||
    typeof labels !== 'object' ||
    Array.isArray(labels)
  ) {
    throw new Error('externally labelled evaluation data is unreadable');
  }

  const fingerprints = new Set();
  const counts = {
    actionable: 0,
    ambiguous: 0,
    duplicateNoise: 0,
    unsafe: 0,
  };
  for (const finding of report.findings) {
    const fingerprint = finding?.fingerprint;
    if (
      typeof fingerprint !== 'string' ||
      fingerprint.length === 0 ||
      fingerprints.has(fingerprint)
    ) {
      throw new Error('report finding fingerprints are missing or duplicated');
    }
    fingerprints.add(fingerprint);
    if (!Object.hasOwn(labels, fingerprint)) {
      throw new Error(`missing external label for finding: ${fingerprint}`);
    }
    const label = labels[fingerprint];
    if (!EXTERNAL_LABELS.has(label)) {
      throw new Error(`unknown external finding label: ${String(label)}`);
    }
    if (label === 'correct/actionable') {
      counts.actionable += 1;
    } else if (label === 'duplicate/noise') {
      counts.duplicateNoise += 1;
    } else if (label === 'ambiguous') {
      counts.ambiguous += 1;
    } else {
      counts.unsafe += 1;
    }
  }
  const extraLabels = Object.keys(labels).filter((fingerprint) => !fingerprints.has(fingerprint));
  if (extraLabels.length > 0) {
    throw new Error(`external labels do not match this report: ${extraLabels.join(', ')}`);
  }

  const sampleCount = fingerprints.size;
  const precisionDenominator = counts.actionable + counts.duplicateNoise + counts.unsafe;
  return {
    criticalFalsePositives: 0,
    duplicateRate: sampleCount === 0 ? 0 : counts.duplicateNoise / sampleCount,
    noiseRate: sampleCount === 0 ? 0 : counts.duplicateNoise / sampleCount,
    precision: precisionDenominator === 0 ? 0 : counts.actionable / precisionDenominator,
    reportCount: sampleCount === 0 ? 0 : 1,
    routineId,
    sampleCount,
    unsafeFindings: counts.unsafe,
  };
}

export function assertLabeledReportPromotionReady(policy, evaluation) {
  const summary = evaluateExternallyLabeledReport(evaluation);
  assertPromotionReady(policy, summary);
  return summary;
}
