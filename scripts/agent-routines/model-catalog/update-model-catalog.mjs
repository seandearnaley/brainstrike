import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { classifyCatalogDelta } from './classify-catalog-delta.mjs';
import { buildEvidenceIndex } from './evidence.mjs';
import { parseProviderRegistry } from './registry-reader.mjs';
import { createReport, renderMarkdown } from './report.mjs';
import { loadSourceManifest } from './source-manifest.mjs';
import { fetchSource } from './sources/index.mjs';

const root = new URL('../../../', import.meta.url);
const digest = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
export async function runReport({
  fetchImpl = fetch,
  now = () => new Date(),
  env = process.env,
} = {}) {
  const manifestUrl = new URL('./source-manifest.json', import.meta.url);
  const manifestText = await readFile(manifestUrl, 'utf8');
  const manifest = await loadSourceManifest(manifestUrl);
  const registryText = await readFile(
    new URL('packages/assistant-contract/src/provider-registry.ts', root),
    'utf8'
  );
  const registry = parseProviderRegistry({
    importedStringConstants: { GEMMA4_E2B_MODEL_ID: 'google/gemma-4-e2b' },
    registrySource: registryText,
  });
  const statuses = [];
  for (const source of manifest.sources.filter(({ enabled }) => enabled)) {
    statuses.push(
      await fetchSource({
        credential: source.credential.env ? env[source.credential.env] : undefined,
        fetchImpl,
        now,
        source,
      })
    );
  }
  const observations = statuses
    .filter(({ status }) => status === 'success')
    .map(({ observation }) => observation);
  const evidence = buildEvidenceIndex({
    now: now(),
    observations,
    sourcePolicies: new Map(manifest.sources.map((source) => [source.id, source])),
  });
  const deltas = classifyCatalogDelta({ evidence, manifest, registry, sourceStatuses: statuses });
  const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const report = createReport({
    baseCommit,
    deltas,
    generatedAt: now().toISOString(),
    manifestSha256: digest(manifestText),
    registry,
    sources: statuses,
  });
  const directory = new URL('reports/model-catalog/', root);
  await mkdir(directory, { recursive: true });
  await writeFile(
    new URL('model-catalog-report.json', directory),
    `${JSON.stringify(report, null, 2)}\n`
  );
  await writeFile(new URL('model-catalog-report.md', directory), renderMarkdown(report));
  return {
    report,
    requiredSourceFailed: statuses.some(
      ({ required, status }) => required === true && status !== 'success'
    ),
  };
}
if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  if (process.argv.slice(2).join(' ') !== '--mode report') {
    throw new Error('scheduled entrypoint supports only --mode report');
  }
  const result = await runReport();
  if (result.requiredSourceFailed) {
    process.exitCode = 1;
  }
}
