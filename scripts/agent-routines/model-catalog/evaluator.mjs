import { assertPromotionReady, createPromotionPolicy } from '../shared/policy.mjs';
import { canonicalReportId } from '../shared/shadow-report.mjs';
import { modelCatalogFindingId, validateModelCatalogReport } from './report.mjs';

const LABELS = new Set(['ambiguous', 'correct_actionable', 'duplicate_noise', 'unsafe']);
export const MODEL_CATALOG_PROMOTION_POLICY = createPromotionPolicy({
  maxDuplicateRate: 0.1,
  maxNoiseRate: 0.1,
  minimumPrecisionByRoutine: { 'model-catalog-updater': 1 },
  minimumReports: 10,
  minimumSamples: 10,
});

function validateReportCorpus(reports) {
  if (!Array.isArray(reports) || reports.length === 0) {
    throw new Error('model catalog report corpus is unreadable');
  }
  const reportIds = new Set();
  const findingIds = new Set();
  const reportFindings = new Set();
  for (const artifact of reports) {
    validateModelCatalogReport(artifact?.report);
    if (
      artifact?.routineId !== 'model-catalog-updater' ||
      artifact.report?.routineId !== artifact.routineId ||
      artifact.reportId !== canonicalReportId(artifact.report) ||
      reportIds.has(artifact.reportId) ||
      !/^[0-9a-f]{40}$/u.test(artifact.report?.baseCommit) ||
      artifact.report?.schemaVersion !== 1 ||
      artifact.report?.mode !== 'report' ||
      !Array.isArray(artifact.report.deltas) ||
      artifact.report.deltas.length === 0
    ) {
      throw new Error('report artifacts are invalid or duplicated');
    }
    reportIds.add(artifact.reportId);
    for (const finding of artifact.report.deltas) {
      const findingId = finding?.findingId;
      if (
        typeof finding?.providerId !== 'string' ||
        finding.providerId.length === 0 ||
        typeof finding.modelId !== 'string' ||
        finding.modelId.length === 0 ||
        typeof finding.kind !== 'string' ||
        finding.kind.length === 0 ||
        findingId !== modelCatalogFindingId(finding) ||
        findingIds.has(findingId)
      ) {
        throw new Error('report finding IDs are empty, duplicated, or shared');
      }
      findingIds.add(findingId);
      reportFindings.add(`${artifact.reportId}\0${findingId}`);
    }
  }
  return { reportCount: reportIds.size, reportFindings };
}

export function evaluateLabelledReports(evaluation) {
  const { labels, reports } = evaluation ?? {};
  const { reportCount, reportFindings } = validateReportCorpus(reports);
  if (!Array.isArray(labels) || labels.length === 0) {
    throw new Error('missing external labels');
  }
  const labelledFindings = new Set();
  for (const record of labels) {
    const pair = `${record?.reportId}\0${record?.findingId}`;
    if (
      !record ||
      typeof record.findingId !== 'string' ||
      record.findingId.length === 0 ||
      typeof record.reportId !== 'string' ||
      record.reportId.length === 0 ||
      !LABELS.has(record.label) ||
      labelledFindings.has(pair)
    ) {
      throw new Error(`missing external label for finding: ${record?.findingId ?? 'unknown'}`);
    }
    labelledFindings.add(pair);
  }
  if (
    labelledFindings.size !== reportFindings.size ||
    [...labelledFindings].some((pair) => !reportFindings.has(pair))
  ) {
    throw new Error('external labels do not match report findings');
  }

  const count = (label) => labels.filter((record) => record.label === label).length;
  const sampleCount = labels.length;
  const duplicate = count('duplicate_noise');
  const unsafe = count('unsafe');
  const correct = count('correct_actionable');
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
export function assertLabelledReportsPromotionReady(policy, evaluation) {
  const summary = evaluateLabelledReports(evaluation);
  assertPromotionReady(policy, summary);
  return summary;
}
