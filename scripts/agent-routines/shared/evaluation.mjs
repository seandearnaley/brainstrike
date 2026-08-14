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

function collectExternalLabels({ labels, report, routineId }) {
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
  const collectedLabels = [];
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
    collectedLabels.push(label);
  }

  const extraLabels = Object.keys(labels).filter((fingerprint) => !fingerprints.has(fingerprint));
  if (extraLabels.length > 0) {
    throw new Error(`external labels do not match this report: ${extraLabels.join(', ')}`);
  }
  return { collectedLabels, routineId };
}

function summarizeExternalLabels({ labels, reportCount, routineId }) {
  const counts = {
    actionable: 0,
    ambiguous: 0,
    duplicateNoise: 0,
    unsafe: 0,
  };
  for (const label of labels) {
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

  const sampleCount = labels.length;
  const precisionDenominator = counts.actionable + counts.duplicateNoise + counts.unsafe;
  return {
    criticalFalsePositives: 0,
    duplicateRate: sampleCount === 0 ? 0 : counts.duplicateNoise / sampleCount,
    noiseRate: sampleCount === 0 ? 0 : counts.duplicateNoise / sampleCount,
    precision: precisionDenominator === 0 ? 0 : counts.actionable / precisionDenominator,
    reportCount,
    routineId,
    sampleCount,
    unsafeFindings: counts.unsafe,
  };
}

export function evaluateExternallyLabeledReport(evaluation) {
  const { collectedLabels, routineId } = collectExternalLabels(evaluation);
  return summarizeExternalLabels({
    labels: collectedLabels,
    reportCount: collectedLabels.length === 0 ? 0 : 1,
    routineId,
  });
}

export function evaluateLabeledReportCorpus(cases) {
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error('externally labelled report corpus is unreadable');
  }
  const reportIds = new Set();
  const labels = [];
  let routineId;

  for (const evaluation of cases) {
    if (
      !evaluation ||
      typeof evaluation !== 'object' ||
      typeof evaluation.reportId !== 'string' ||
      evaluation.reportId.length === 0 ||
      reportIds.has(evaluation.reportId)
    ) {
      throw new Error('report corpus IDs are missing or duplicated');
    }
    reportIds.add(evaluation.reportId);
    const collected = collectExternalLabels(evaluation);
    if (collected.collectedLabels.length === 0) {
      throw new Error('promotion corpus reports must be non-empty');
    }
    if (routineId === undefined) {
      routineId = collected.routineId;
    } else if (routineId !== collected.routineId) {
      throw new Error('report corpus mixes routine IDs');
    }
    labels.push(...collected.collectedLabels);
  }

  return summarizeExternalLabels({ labels, reportCount: reportIds.size, routineId });
}

export function assertLabeledReportPromotionReady(policy, evaluation) {
  const summary = evaluateExternallyLabeledReport(evaluation);
  assertPromotionReady(policy, summary);
  return summary;
}

export function assertLabeledReportCorpusPromotionReady(policy, cases) {
  const summary = evaluateLabeledReportCorpus(cases);
  assertPromotionReady(policy, summary);
  return summary;
}
