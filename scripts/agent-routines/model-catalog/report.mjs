import { createHash } from 'node:crypto';

const SUMMARY_KEYS = {
  aligned: 'aligned',
  conflict: 'conflict',
  field_drift: 'fieldDrift',
  ignored: 'ignored',
  registry_missing_remote: 'registryMissingRemote',
  remote_addition_candidate: 'remoteAdditionCandidate',
  unverifiable: 'unverifiable',
};
const DELTA_KINDS = new Set(Object.keys(SUMMARY_KEYS));
const SAFETY_DISPOSITIONS = new Set(['blocked', 'report_only', 'safe_addition']);
const DISPOSITIONS_BY_KIND = {
  aligned: new Set(['report_only']),
  conflict: new Set(['blocked']),
  field_drift: new Set(['report_only']),
  ignored: new Set(['report_only']),
  registry_missing_remote: new Set(['report_only']),
  remote_addition_candidate: new Set(['blocked', 'report_only', 'safe_addition']),
  unverifiable: new Set(['blocked']),
};
const SOURCE_STATUSES = new Set(['failed', 'skipped_missing_secret', 'success']);
const EVIDENCE_FIELDS = new Set([
  'catalogEligibility',
  'catalogEligibilityReason',
  'catalogLimitsConsistent',
  'contextWindow',
  'createdAt',
  'id',
  'inputModalities',
  'label',
  'maxOutputTokens',
  'outputModalities',
  'pricing',
  'supportsStreaming',
  'type',
  'vision',
]);
const SUMMARY_FIELDS = [
  'aligned',
  'blocked',
  'conflict',
  'fieldDrift',
  'ignored',
  'registryMissingRemote',
  'remoteAdditionCandidate',
  'safeAdditions',
  'unverifiable',
];

function isEvidenceEntry(entry, { generatedAt, sourceIds }) {
  if (
    !(
      hasExactKeys(entry, [
        'authority',
        'freshness',
        'jsonPointer',
        'rawValueSha256',
        'retrievedAt',
        'sourceId',
        'sourceModelId',
        'sourceUrl',
        'value',
      ]) &&
      ['route', 'vendor'].includes(entry.authority) &&
      ['live', 'stale'].includes(entry.freshness)
    ) ||
    typeof entry.jsonPointer !== 'string' ||
    !entry.jsonPointer.startsWith('/') ||
    typeof entry.retrievedAt !== 'string' ||
    !Number.isFinite(Date.parse(entry.retrievedAt)) ||
    new Date(entry.retrievedAt).toISOString() !== entry.retrievedAt ||
    Date.parse(entry.retrievedAt) > Date.parse(generatedAt) ||
    typeof entry.sourceId !== 'string' ||
    !sourceIds.has(entry.sourceId) ||
    typeof entry.sourceModelId !== 'string' ||
    entry.sourceModelId.length === 0 ||
    typeof entry.sourceUrl !== 'string'
  ) {
    return false;
  }
  try {
    const expectedValueSha = `sha256:${createHash('sha256')
      .update(JSON.stringify(entry.value))
      .digest('hex')}`;
    return (
      entry.rawValueSha256 === expectedValueSha && new URL(entry.sourceUrl).protocol === 'https:'
    );
  } catch {
    return false;
  }
}

function isEvidenceArray(value, context) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => isEvidenceEntry(item, context))
  );
}

function isEvidenceIndex(value, context) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0 &&
    Object.entries(value).every(
      ([field, item]) =>
        EVIDENCE_FIELDS.has(field) &&
        hasExactKeys(item, ['evidence', 'status', 'value']) &&
        ['resolved', 'stale'].includes(item.status) &&
        isEvidenceArray(item.evidence, context) &&
        item.evidence.every((entry) => JSON.stringify(entry.value) === JSON.stringify(item.value))
    )
  );
}

function isSafeAdditionEvidence(evidence) {
  const required = [
    'contextWindow',
    'inputModalities',
    'maxOutputTokens',
    'outputModalities',
    'pricing',
    'supportsStreaming',
    'type',
    'vision',
  ];
  const vendorOwned = ['contextWindow', 'maxOutputTokens', 'vision'];
  return (
    required.every((field) => evidence[field]) &&
    Object.values(evidence).every(
      (item) =>
        item.status === 'resolved' && item.evidence.every(({ freshness }) => freshness === 'live')
    ) &&
    vendorOwned.every((field) =>
      evidence[field].evidence.some(({ authority }) => authority === 'vendor')
    ) &&
    Array.isArray(evidence.inputModalities.value) &&
    evidence.inputModalities.value.every((modality) => ['image', 'text'].includes(modality)) &&
    Array.isArray(evidence.outputModalities.value) &&
    evidence.outputModalities.value.every((modality) => modality === 'text') &&
    evidence.supportsStreaming.value === true &&
    evidence.catalogLimitsConsistent?.value !== false
  );
}

function validRemoteSafety(delta) {
  if (delta.kind !== 'remote_addition_candidate') {
    return true;
  }
  const blockingReason = delta.safety.reasons.some((reason) =>
    /^(global ID collision|gateway output limit|unknown required field|unsupported input|unsupported output)/u.test(
      reason
    )
  );
  if (delta.safety.disposition === 'blocked') {
    return blockingReason;
  }
  if (delta.safety.disposition === 'safe_addition') {
    return (
      delta.providerId === 'openrouter' &&
      delta.safety.reasons.length === 0 &&
      isSafeAdditionEvidence(delta.evidence)
    );
  }
  return delta.providerId !== 'openrouter' || delta.safety.reasons.length > 0;
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

export function validateModelCatalogReport(report) {
  const invalid = () => {
    throw new Error('model catalog report does not match createReport schema');
  };
  if (
    !(
      hasExactKeys(report, [
        'baseCommit',
        'deltas',
        'generatedAt',
        'manifestSha256',
        'mode',
        'registry',
        'routineId',
        'schemaVersion',
        'sources',
        'summary',
      ]) && /^[0-9a-f]{40}$/u.test(report.baseCommit)
    ) ||
    report.routineId !== 'model-catalog-updater' ||
    report.schemaVersion !== 1 ||
    report.mode !== 'report' ||
    typeof report.generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(report.generatedAt)) ||
    new Date(report.generatedAt).toISOString() !== report.generatedAt ||
    !/^sha256:[0-9a-f]{64}$/u.test(report.manifestSha256) ||
    !Array.isArray(report.deltas) ||
    !Array.isArray(report.sources) ||
    !hasExactKeys(report.registry, ['modelCount', 'path', 'providerCounts']) ||
    report.registry.path !== 'packages/assistant-contract/src/provider-registry.ts' ||
    !Number.isSafeInteger(report.registry.modelCount) ||
    report.registry.modelCount < 0 ||
    !report.registry.providerCounts ||
    typeof report.registry.providerCounts !== 'object' ||
    Array.isArray(report.registry.providerCounts) ||
    Object.entries(report.registry.providerCounts).some(
      ([providerId, count]) => providerId.length === 0 || !Number.isSafeInteger(count) || count < 0
    ) ||
    Object.values(report.registry.providerCounts).reduce((sum, count) => sum + count, 0) !==
      report.registry.modelCount ||
    !hasExactKeys(report.summary, SUMMARY_FIELDS) ||
    !Object.values(report.summary).every((count) => Number.isSafeInteger(count) && count >= 0)
  ) {
    invalid();
  }

  const expectedSummary = Object.fromEntries(SUMMARY_FIELDS.map((key) => [key, 0]));
  const evidenceContext = {
    generatedAt: report.generatedAt,
    sourceIds: new Set(report.sources.map(({ sourceId }) => sourceId)),
  };
  const findingIds = new Set();
  for (const delta of report.deltas) {
    if (
      !delta ||
      typeof delta !== 'object' ||
      Array.isArray(delta) ||
      !DELTA_KINDS.has(delta.kind)
    ) {
      invalid();
    }
    const hasField = ['conflict', 'field_drift'].includes(delta.kind);
    const hasEvidence =
      hasField || ['remote_addition_candidate', 'unverifiable'].includes(delta.kind);
    const deltaKeys = [
      ...(hasEvidence ? ['evidence'] : []),
      ...(hasField ? ['field'] : []),
      'findingId',
      'kind',
      'modelId',
      'providerId',
      'safety',
    ].sort();
    if (
      !hasExactKeys(delta, deltaKeys) ||
      typeof delta.providerId !== 'string' ||
      delta.providerId.length === 0 ||
      typeof delta.modelId !== 'string' ||
      delta.modelId.length === 0 ||
      (hasField && (typeof delta.field !== 'string' || delta.field.length === 0)) ||
      (hasField && !isEvidenceArray(delta.evidence, evidenceContext)) ||
      (hasEvidence && !hasField && !isEvidenceIndex(delta.evidence, evidenceContext)) ||
      !hasExactKeys(delta.safety, ['disposition', 'reasons']) ||
      !SAFETY_DISPOSITIONS.has(delta.safety.disposition) ||
      !DISPOSITIONS_BY_KIND[delta.kind].has(delta.safety.disposition) ||
      !validRemoteSafety(delta) ||
      !Array.isArray(delta.safety.reasons) ||
      delta.safety.reasons.some((reason) => typeof reason !== 'string' || reason.length === 0) ||
      delta.findingId !== modelCatalogFindingId(delta) ||
      findingIds.has(delta.findingId)
    ) {
      invalid();
    }
    findingIds.add(delta.findingId);
    expectedSummary[SUMMARY_KEYS[delta.kind]] += 1;
    if (delta.safety.disposition === 'safe_addition') {
      expectedSummary.safeAdditions += 1;
    }
    if (delta.safety.disposition === 'blocked') {
      expectedSummary.blocked += 1;
    }
  }
  if (SUMMARY_FIELDS.some((key) => report.summary[key] !== expectedSummary[key])) {
    invalid();
  }

  const sourceIds = new Set();
  for (const source of report.sources) {
    if (!source || typeof source !== 'object' || !SOURCE_STATUSES.has(source.status)) {
      invalid();
    }
    const keys =
      source.status === 'failed'
        ? ['error', 'required', 'sourceId', 'status']
        : ['required', 'sourceId', 'status'];
    if (
      !hasExactKeys(source, keys) ||
      typeof source.required !== 'boolean' ||
      typeof source.sourceId !== 'string' ||
      source.sourceId.length === 0 ||
      sourceIds.has(source.sourceId) ||
      (source.status === 'failed' &&
        (typeof source.error !== 'string' || source.error.length === 0))
    ) {
      invalid();
    }
    sourceIds.add(source.sourceId);
  }
  return report;
}

const replaceControlCharacters = (value) =>
  [...String(value)]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? '�' : character;
    })
    .join('');

const markdownText = (value) =>
  replaceControlCharacters(value).replaceAll(/([\\`*_[\]{}()#+.!|<>])/gu, '\\$1');

export const modelCatalogFindingId = (delta) =>
  createHash('sha256')
    .update(JSON.stringify([delta.providerId, delta.modelId, delta.kind, delta.field ?? null]))
    .digest('hex')
    .slice(0, 24);

export function createReport({
  baseCommit,
  generatedAt,
  manifestSha256,
  registry,
  sources,
  deltas,
}) {
  const reportDeltas = deltas.map((delta) => ({
    ...delta,
    findingId: modelCatalogFindingId(delta),
  }));
  if (new Set(reportDeltas.map((delta) => delta.findingId)).size !== reportDeltas.length) {
    throw new Error('model catalog report findings are duplicated');
  }
  const summary = {
    aligned: 0,
    blocked: 0,
    conflict: 0,
    fieldDrift: 0,
    ignored: 0,
    registryMissingRemote: 0,
    remoteAdditionCandidate: 0,
    safeAdditions: 0,
    unverifiable: 0,
  };
  for (const delta of reportDeltas) {
    summary[SUMMARY_KEYS[delta.kind]] += 1;
    if (delta.safety.disposition === 'safe_addition') {
      summary.safeAdditions += 1;
    }
    if (delta.safety.disposition === 'blocked') {
      summary.blocked += 1;
    }
  }
  return {
    baseCommit,
    deltas: reportDeltas,
    generatedAt,
    manifestSha256,
    mode: 'report',
    registry: {
      modelCount: registry.models.length,
      path: 'packages/assistant-contract/src/provider-registry.ts',
      providerCounts: registry.providerCounts,
    },
    routineId: 'model-catalog-updater',
    schemaVersion: 1,
    sources: [...sources]
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
      .map(({ observation: _observation, ...status }) => status),
    summary,
  };
}

export function renderMarkdown(report) {
  const requiredFailure = report.sources.some(
    ({ required, status }) => required !== false && status !== 'success'
  );
  const optionalCredentialSkipped = report.sources.some(
    ({ required, status }) => required === false && status === 'skipped_missing_secret'
  );
  const optionalAttemptFailure = report.sources.some(
    ({ required, status }) =>
      required === false && status !== 'success' && status !== 'skipped_missing_secret'
  );
  const completeness = requiredFailure
    ? '> **Incomplete:** at least one required source failed.'
    : optionalAttemptFailure
      ? '> **Incomplete:** at least one attempted optional source failed.'
      : optionalCredentialSkipped
        ? '> **Complete:** required sources succeeded; optional sources were skipped because credentials are absent.'
        : '> **Complete:** all configured sources were observed.';
  const lines = [
    '# Model Catalog Shadow Report',
    '',
    `Base: ${markdownText(report.baseCommit)}  `,
    `Generated: ${markdownText(report.generatedAt)}`,
    '',
    completeness,
    '',
    '## Source status',
    '',
    '| Source | Status |',
    '| --- | --- |',
    ...report.sources.map(
      ({ required, sourceId, status }) =>
        `| ${markdownText(sourceId)} | ${markdownText(status)}${required === false ? ' (optional)' : ''} |`
    ),
    '',
    '## Summary',
    '',
    ...Object.entries(report.summary).map(([key, value]) => `- ${markdownText(key)}: ${value}`),
  ];
  for (const [title, kinds] of [
    ['Safe additions', []],
    ['Conflicts and blocked candidates', ['conflict', 'unverifiable']],
    ['Remote additions', ['remote_addition_candidate']],
    ['Registry IDs missing upstream', ['registry_missing_remote']],
    ['Field drift', ['field_drift']],
  ]) {
    lines.push('', `## ${title}`, '');
    const rows =
      title === 'Safe additions'
        ? report.deltas.filter((d) => d.safety.disposition === 'safe_addition')
        : report.deltas.filter((d) => kinds.includes(d.kind));
    lines.push(
      ...(rows.length
        ? rows.map(
            (d) =>
              `- ${markdownText(d.providerId)}:${markdownText(d.modelId)} — ${markdownText(d.kind)}`
          )
        : ['- None.'])
    );
  }
  lines.push(
    '',
    '## Caveats',
    '',
    '- Reports never authorize deletes, renames, defaults, disables, or preference remaps.',
    '- Official prose/news may be leads only; structured fields require captured JSON-pointer evidence.',
    ''
  );
  return lines.join('\n');
}
