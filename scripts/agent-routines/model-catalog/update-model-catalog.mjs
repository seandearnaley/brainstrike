import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createBlockedRoutineResult } from '../shared/blocked-result.mjs';
import { freezeCurrentOriginMain, readCurrentHeadSha } from '../shared/current-main.mjs';
import { createRoutineResultWriter } from '../shared/routine-result.mjs';
import { fingerprint } from '../shared/shadow-report.mjs';
import { classifyCatalogDelta } from './classify-catalog-delta.mjs';
import { buildEvidenceIndex } from './evidence.mjs';
import { parseProviderRegistry } from './registry-reader.mjs';
import { createReport, renderMarkdown } from './report.mjs';
import { loadSourceManifest } from './source-manifest.mjs';
import { fetchSource } from './sources/index.mjs';

const root = new URL('../../../', import.meta.url);
const digest = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
export async function runReport({
  baseSha,
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
  const report = createReport({
    baseCommit: baseSha,
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
    attemptedOptionalSourceFailed: statuses.some(
      ({ required, status }) => required === false && status === 'failed'
    ),
    report,
    requiredSourceFailed: statuses.some(
      ({ required, status }) => required === true && status !== 'success'
    ),
  };
}
async function writeBlockedDiagnostic(reason, baseSha) {
  const directory = new URL('reports/model-catalog/', root);
  await mkdir(directory, { recursive: true });
  await writeFile(
    new URL('model-catalog-report.json', directory),
    `${JSON.stringify({ baseCommit: baseSha, error: reason, mode: 'report', status: 'blocked' }, null, 2)}\n`
  );
  await writeFile(
    new URL('model-catalog-report.md', directory),
    `# Model Catalog Shadow Report\n\nBlocked: ${reason}\n`
  );
}

export async function runModelCatalogMain({
  freezeMain = freezeCurrentOriginMain,
  mode = '--mode report',
  readHead = readCurrentHeadSha,
  runReport: executeReport = runReport,
  setExitCode = () => {},
  terminalWriter = createRoutineResultWriter(),
  writeDiagnostic = writeBlockedDiagnostic,
} = {}) {
  let baseSha = /^[0-9a-f]{40}$/u.test(process.env.GITHUB_SHA ?? '')
    ? process.env.GITHUB_SHA
    : '0'.repeat(40);
  let terminalResult;
  try {
    if (mode !== '--mode report') {
      throw new Error('scheduled entrypoint supports only --mode report');
    }
    baseSha = await readHead();
    baseSha = await freezeMain();
    const result = await executeReport({ baseSha });
    const findingCount =
      result.report.summary.conflict +
      result.report.summary.fieldDrift +
      result.report.summary.registryMissingRemote +
      result.report.summary.remoteAdditionCandidate +
      result.report.summary.unverifiable;
    if (result.requiredSourceFailed) {
      terminalResult = {
        baseSha,
        fingerprint: fingerprint(['model-catalog-updater', baseSha, 'required-source-failed']),
        reasons: ['required model-catalog source failed'],
        status: 'blocked',
      };
    } else if (result.attemptedOptionalSourceFailed) {
      terminalResult = {
        baseSha,
        fingerprint: fingerprint(['model-catalog-updater', baseSha, 'optional-source-failed']),
        reasons: ['attempted optional model-catalog source failed'],
        status: 'blocked',
      };
    } else if (findingCount > 0) {
      terminalResult = {
        baseSha,
        fingerprint: fingerprint(['model-catalog-updater', baseSha, String(findingCount)]),
        status: 'report',
        summary: `${findingCount} catalog difference(s)`,
      };
    } else {
      terminalResult = {
        baseSha,
        fingerprint: fingerprint(['model-catalog-updater', baseSha, 'no-change']),
        status: 'no-change',
      };
    }
  } catch (error) {
    terminalResult = await createBlockedRoutineResult({
      baseSha,
      error,
      routineId: 'model-catalog-updater',
      writeDiagnostic,
    });
  }
  terminalWriter.write(terminalResult);
  terminalWriter.assertWritten();
  if (terminalResult.status === 'blocked') {
    setExitCode(1);
  }
  return terminalResult;
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  await runModelCatalogMain({
    mode: process.argv.slice(2).join(' '),
    setExitCode: (code) => {
      process.exitCode = code;
    },
  });
}
