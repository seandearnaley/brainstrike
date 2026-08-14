const REQUIRED = [
  'contextWindow',
  'maxOutputTokens',
  'pricing',
  'supportsStreaming',
  'type',
  'vision',
];
const DRIFT_FIELDS = new Set([
  'contextWindow',
  'maxOutputTokens',
  'pricing',
  'supportsStreaming',
  'type',
  'vision',
]);
const RECENT_RELEASE_WINDOW_MS = 96 * 60 * 60 * 1000;
const ORDER = [
  'aligned',
  'remote_addition_candidate',
  'registry_missing_remote',
  'field_drift',
  'conflict',
  'unverifiable',
  'ignored',
];
const compare = (a, b) =>
  a.providerId.localeCompare(b.providerId) ||
  a.modelId.localeCompare(b.modelId) ||
  ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) ||
  (a.field ?? '').localeCompare(b.field ?? '');
export function classifyCatalogDelta({ registry, evidence, sourceStatuses, manifest }) {
  const currentByKey = new Map(
    registry.models.map((model) => [`${model.providerId}:${model.id}`, model])
  );
  const globalIds = new Map(registry.models.map((model) => [model.id, model.providerId]));
  const deltas = [];
  for (const [key, fields] of evidence) {
    const split = key.indexOf(':');
    const providerId = key.slice(0, split);
    const modelId = key.slice(split + 1);
    const current = currentByKey.get(key);
    if (fields.get('catalogEligibility')?.value === false) {
      const reason = fields.get('catalogEligibilityReason')?.value;
      deltas.push({
        kind: 'ignored',
        modelId,
        providerId,
        safety: {
          disposition: 'report_only',
          reasons: [`${reason ?? 'ineligible route'} is not a fixed model route`],
        },
      });
      continue;
    }
    const conflicts = [...fields.entries()].filter(([, item]) => item.status === 'conflict');
    if (conflicts.length) {
      for (const [field, item] of conflicts) {
        deltas.push({
          evidence: item.evidence,
          field,
          kind: 'conflict',
          modelId,
          providerId,
          safety: { disposition: 'blocked', reasons: ['conflicting field evidence'] },
        });
      }
      continue;
    }
    if (!current) {
      const source = manifest.sources.find((item) => item.providerId === providerId);
      const missing = REQUIRED.filter(
        (name) => !fields.has(name) || fields.get(name).status !== 'resolved'
      );
      const collision = globalIds.get(modelId);
      const approved = source?.safeAddition?.approvedModelIds?.includes(modelId) === true;
      const createdAt = fields.get('createdAt')?.value;
      const observedAt = fields.get('id')?.evidence?.[0]?.retrievedAt;
      const releaseAge =
        typeof createdAt === 'string' && typeof observedAt === 'string'
          ? Date.parse(observedAt) - Date.parse(createdAt)
          : Number.NaN;
      const recent =
        Number.isFinite(releaseAge) && releaseAge >= 0 && releaseAge <= RECENT_RELEASE_WINDOW_MS;
      if (!(approved || recent)) {
        deltas.push({
          kind: 'ignored',
          modelId,
          providerId,
          safety: {
            disposition: 'report_only',
            reasons: ['historical unapproved upstream inventory'],
          },
        });
        continue;
      }
      const inputModalities = fields.get('inputModalities')?.value;
      const outputModalities = fields.get('outputModalities')?.value;
      const unsupportedInputs = Array.isArray(inputModalities)
        ? inputModalities.filter((modality) => !['text', 'image'].includes(modality))
        : ['unknown'];
      const unsupportedOutputs = Array.isArray(outputModalities)
        ? outputModalities.filter((modality) => modality !== 'text')
        : ['unknown'];
      const routeCompatible = unsupportedInputs.length === 0 && unsupportedOutputs.length === 0;
      const limitsConsistent = fields.get('catalogLimitsConsistent')?.value !== false;
      const fresh = [...fields.values()].every(
        (item) =>
          item.status === 'resolved' && item.evidence.every((entry) => entry.freshness === 'live')
      );
      const safe =
        providerId === 'openrouter' &&
        source?.catalogCompleteness === 'exhaustive' &&
        source.streamingPolicy === true &&
        approved &&
        !collision &&
        missing.length === 0 &&
        routeCompatible &&
        limitsConsistent &&
        fresh;
      const reasons = [
        ...missing.map((name) => `unknown required field: ${name}`),
        ...(approved ? [] : ['model ID is not explicitly approved']),
        ...(collision ? [`global ID collision with ${collision}`] : []),
        ...(unsupportedInputs.length
          ? [`unsupported input modalities: ${unsupportedInputs.join(', ')}`]
          : []),
        ...(unsupportedOutputs.length
          ? [`unsupported output modalities: ${unsupportedOutputs.join(', ')}`]
          : []),
        ...(limitsConsistent ? [] : ['gateway output limit exceeds context window']),
        ...(fresh ? [] : ['stale evidence']),
      ];
      deltas.push({
        evidence: Object.fromEntries(fields),
        kind: missing.length ? 'unverifiable' : 'remote_addition_candidate',
        modelId,
        providerId,
        safety: {
          disposition: safe
            ? 'safe_addition'
            : missing.length || collision || !routeCompatible || !limitsConsistent
              ? 'blocked'
              : 'report_only',
          reasons,
        },
      });
      continue;
    }
    const drift = [...fields.entries()].filter(
      ([name, item]) =>
        DRIFT_FIELDS.has(name) &&
        name in current.fields &&
        item.status === 'resolved' &&
        JSON.stringify(current.fields[name]) !== JSON.stringify(item.value)
    );
    if (drift.length) {
      for (const [field, item] of drift) {
        deltas.push({
          evidence: item.evidence,
          field,
          kind: 'field_drift',
          modelId,
          providerId,
          safety: {
            disposition: 'report_only',
            reasons: ['registry differs from structured evidence'],
          },
        });
      }
    } else {
      deltas.push({
        kind: 'aligned',
        modelId,
        providerId,
        safety: { disposition: 'report_only', reasons: [] },
      });
    }
  }
  const successful = new Set(
    sourceStatuses.filter(({ status }) => status === 'success').map(({ sourceId }) => sourceId)
  );
  for (const model of registry.models) {
    const source = manifest.sources.find(
      (item) =>
        item.providerId === model.providerId &&
        item.catalogCompleteness === 'exhaustive' &&
        successful.has(item.id)
    );
    if (source && !evidence.has(`${model.providerId}:${model.id}`)) {
      deltas.push({
        kind: 'registry_missing_remote',
        modelId: model.id,
        providerId: model.providerId,
        safety: {
          disposition: 'report_only',
          reasons: ['exhaustive source omitted registry ID; no delete is authorized'],
        },
      });
    }
  }
  return deltas.sort(compare);
}
