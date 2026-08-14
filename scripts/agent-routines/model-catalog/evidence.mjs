export function buildEvidenceIndex({ observations, now, sourcePolicies }) {
  const index = new Map();
  for (const observation of observations) {
    const policy = sourcePolicies.get(observation.sourceId);
    if (!policy) {
      throw new Error(`missing source policy: ${observation.sourceId}`);
    }
    const authority =
      policy.sourceKind === 'vendor-model-list-api'
        ? 'vendor'
        : policy.sourceKind === 'gateway-model-list-api'
          ? 'route'
          : undefined;
    if (!authority) {
      throw new Error(`unsupported source kind: ${String(policy.sourceKind)}`);
    }
    const stale =
      now.getTime() - new Date(observation.retrievedAt).getTime() >
      policy.maxObservationAgeHours * 3_600_000;
    for (const model of observation.models) {
      const key = `${model.providerId}:${model.modelId}`;
      const fields = index.get(key) ?? new Map();
      index.set(key, fields);
      for (const [name, item] of Object.entries(model.fields)) {
        const list = fields.get(name)?.evidence ?? [];
        const next = { ...item, authority, freshness: stale ? 'stale' : 'live' };
        const evidence = [...list, next].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
        const values = new Set(evidence.map(({ value }) => JSON.stringify(value)));
        fields.set(name, {
          evidence,
          status: values.size > 1 ? 'conflict' : stale ? 'stale' : 'resolved',
          value: values.size === 1 ? next.value : undefined,
        });
      }
    }
  }
  return index;
}
