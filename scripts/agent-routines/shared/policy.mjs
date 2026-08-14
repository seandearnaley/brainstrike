export function createPromotionPolicy({
  maxDuplicateRate,
  maxNoiseRate,
  minimumPrecisionByRoutine,
  minimumReports,
  minimumSamples,
}) {
  const rates = [maxDuplicateRate, maxNoiseRate, ...Object.values(minimumPrecisionByRoutine)];
  if (
    !Number.isSafeInteger(minimumReports) ||
    minimumReports <= 0 ||
    !Number.isSafeInteger(minimumSamples) ||
    minimumSamples <= 0 ||
    rates.some((rate) => !Number.isFinite(rate) || rate < 0 || rate > 1) ||
    Object.keys(minimumPrecisionByRoutine).length === 0
  ) {
    throw new Error('invalid promotion-readiness policy');
  }
  return Object.freeze({
    maxDuplicateRate,
    maxNoiseRate,
    minimumPrecisionByRoutine: Object.freeze({ ...minimumPrecisionByRoutine }),
    minimumReports,
    minimumSamples,
  });
}

function isValidEvaluationSummary(summary) {
  return (
    summary !== null &&
    typeof summary === 'object' &&
    typeof summary.routineId === 'string' &&
    Number.isSafeInteger(summary.reportCount) &&
    summary.reportCount >= 0 &&
    Number.isSafeInteger(summary.sampleCount) &&
    summary.sampleCount >= 0 &&
    Number.isSafeInteger(summary.criticalFalsePositives) &&
    summary.criticalFalsePositives >= 0 &&
    Number.isSafeInteger(summary.unsafeFindings) &&
    summary.unsafeFindings >= 0 &&
    [summary.duplicateRate, summary.noiseRate, summary.precision].every(
      (rate) => Number.isFinite(rate) && rate >= 0 && rate <= 1
    )
  );
}

export function assertPromotionReady(policy, summary) {
  if (!isValidEvaluationSummary(summary)) {
    throw new Error('calibration data is unreadable; propose-pr mode is forbidden');
  }
  const minimumPrecision = policy.minimumPrecisionByRoutine[summary.routineId];
  if (minimumPrecision === undefined) {
    throw new Error(`no precision threshold configured for routine: ${summary.routineId}`);
  }
  if (
    summary.reportCount < policy.minimumReports ||
    summary.sampleCount < policy.minimumSamples ||
    summary.criticalFalsePositives !== 0 ||
    summary.unsafeFindings !== 0 ||
    summary.duplicateRate > policy.maxDuplicateRate ||
    summary.noiseRate > policy.maxNoiseRate ||
    summary.precision < minimumPrecision
  ) {
    throw new Error(`routine is not promotion-ready: ${summary.routineId}`);
  }
}
