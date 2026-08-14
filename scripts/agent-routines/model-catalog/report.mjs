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

const replaceControlCharacters = (value) =>
  [...String(value)]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? '�' : character;
    })
    .join('');

const markdownText = (value) =>
  replaceControlCharacters(value).replaceAll(/([\\`*_[\]{}()#+.!|<>])/gu, '\\$1');

const findingId = (delta) =>
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
  const reportDeltas = deltas.map((delta) => ({ ...delta, findingId: findingId(delta) }));
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
  const completeness = requiredFailure
    ? '> **Incomplete:** at least one required source failed.'
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
