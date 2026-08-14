const SUMMARY_KEYS = {
  aligned: 'aligned',
  conflict: 'conflict',
  field_drift: 'fieldDrift',
  ignored: 'ignored',
  registry_missing_remote: 'registryMissingRemote',
  remote_addition_candidate: 'remoteAdditionCandidate',
  unverifiable: 'unverifiable',
};
export function createReport({
  baseCommit,
  generatedAt,
  manifestSha256,
  registry,
  sources,
  deltas,
}) {
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
  for (const delta of deltas) {
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
    deltas,
    generatedAt,
    manifestSha256,
    mode: 'report',
    registry: {
      modelCount: registry.models.length,
      path: 'packages/assistant-contract/src/provider-registry.ts',
      providerCounts: registry.providerCounts,
    },
    schemaVersion: 1,
    sources: [...sources]
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
      .map(({ observation: _observation, ...status }) => status),
    summary,
  };
}
export function renderMarkdown(report) {
  const incomplete = report.sources.some(({ status }) => status !== 'success');
  const lines = [
    '# Model Catalog Shadow Report',
    '',
    `Base: \`${report.baseCommit}\`  `,
    `Generated: ${report.generatedAt}`,
    '',
    incomplete
      ? '> **Incomplete:** one or more sources failed or have missing credentials.'
      : '> **Complete:** all configured sources were observed.',
    '',
    '## Source status',
    '',
    '| Source | Status |',
    '| --- | --- |',
    ...report.sources.map(({ sourceId, status }) => `| ${sourceId} | ${status} |`),
    '',
    '## Summary',
    '',
    ...Object.entries(report.summary).map(([key, value]) => `- ${key}: ${value}`),
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
        ? rows.map((d) => `- \`${d.providerId}:${d.modelId}\` — ${d.kind}`)
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
