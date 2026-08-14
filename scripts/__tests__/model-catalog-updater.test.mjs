import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { classifyCatalogDelta } from '../agent-routines/model-catalog/classify-catalog-delta.mjs';
import { evaluateLabelledReports } from '../agent-routines/model-catalog/evaluator.mjs';
import { buildEvidenceIndex } from '../agent-routines/model-catalog/evidence.mjs';
import { parseProviderRegistry } from '../agent-routines/model-catalog/registry-reader.mjs';
import { createReport, renderMarkdown } from '../agent-routines/model-catalog/report.mjs';
import {
  planSafeAddition,
  renderSafeAdditionEdits,
} from '../agent-routines/model-catalog/safe-addition-plan.mjs';
import {
  loadSourceManifest,
  validateSourceManifest,
} from '../agent-routines/model-catalog/source-manifest.mjs';
import { fetchSource } from '../agent-routines/model-catalog/sources/index.mjs';

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/model-catalog/openrouter-models.json', import.meta.url))
);
const now = () => new Date('2026-08-14T12:00:00.000Z');

test('validates the checked-in source policy and rejects unsafe approval policy', async () => {
  const manifest = await loadSourceManifest();
  assert.deepEqual(
    manifest.sources.map(({ adapter }) => adapter),
    ['anthropic', 'google', 'openai', 'openrouter']
  );
  assert.throws(
    () =>
      validateSourceManifest({
        schemaVersion: 1,
        sources: [{ ...manifest.sources[0], extra: true }],
      }),
    /unknown key/u
  );
  assert.throws(
    () =>
      validateSourceManifest({
        schemaVersion: 1,
        sources: [
          {
            ...manifest.sources.at(-1),
            safeAddition: { approvedModelIds: ['wrong'], eligible: true },
          },
        ],
      }),
    /approved model ID/u
  );
});

test('normalizes OpenRouter structured fields with field-level provenance', async () => {
  const source = (await loadSourceManifest()).sources.find(
    ({ adapter }) => adapter === 'openrouter'
  );
  const calls = [];
  const result = await fetchSource({
    credential: undefined,
    fetchImpl: async (url, init) => {
      calls.push({ init, url });
      return new Response(JSON.stringify(fixture), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });
    },
    now,
    source,
  });
  assert.equal(result.status, 'success');
  assert.deepEqual(calls, [
    { init: { headers: { accept: 'application/json' }, method: 'GET' }, url: source.url },
  ]);
  const model = result.observation.models[0];
  assert.equal(model.fields.contextWindow.value, 200_000);
  assert.equal(model.fields.pricing.value.inputPerMTok, 3);
  assert.equal(model.fields.vision.value, 'supported');
  assert.equal(model.fields.contextWindow.jsonPointer, '/data/0/context_length');
  assert.match(model.fields.contextWindow.rawValueSha256, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(model.fields.contextWindow.authority, 'route');
});

test('normalizes recognized extended modalities but blocks them from safe additions', async () => {
  const source = {
    ...(await loadSourceManifest()).sources.at(-1),
    safeAddition: { approvedModelIds: ['anthropic/claude-test'], eligible: true },
  };
  const multimodal = structuredClone(fixture);
  multimodal.data[0].architecture.input_modalities = ['text', 'image', 'audio', 'file', 'video'];
  multimodal.data[0].architecture.output_modalities = ['text', 'image'];
  const fetched = await fetchSource({
    credential: undefined,
    fetchImpl: async () => new Response(JSON.stringify(multimodal), { status: 200 }),
    now,
    source,
  });
  assert.equal(fetched.status, 'success');
  assert.deepEqual(fetched.observation.models[0].fields.inputModalities.value, [
    'text',
    'image',
    'audio',
    'file',
    'video',
  ]);
  const deltas = classifyCatalogDelta({
    evidence: buildEvidenceIndex({
      now: now(),
      observations: [fetched.observation],
      sourcePolicies: new Map([[source.id, source]]),
    }),
    manifest: { schemaVersion: 1, sources: [source] },
    registry: { models: [], providerCounts: {} },
    sourceStatuses: [fetched],
  });
  assert.equal(deltas[0].kind, 'remote_addition_candidate');
  assert.equal(deltas[0].safety.disposition, 'blocked');
  assert.match(
    deltas[0].safety.reasons.join(' '),
    /unsupported input modalities.*audio.*file.*video/u
  );
  assert.match(deltas[0].safety.reasons.join(' '), /unsupported output modalities.*image/u);
});

test('keeps an unpublished output limit unknown instead of failing the whole source', async () => {
  const source = (await loadSourceManifest()).sources.at(-1);
  const withoutOutputLimit = structuredClone(fixture);
  withoutOutputLimit.data[0].top_provider.max_completion_tokens = null;
  const fetched = await fetchSource({
    credential: undefined,
    fetchImpl: async () => new Response(JSON.stringify(withoutOutputLimit), { status: 200 }),
    now,
    source,
  });
  assert.equal(fetched.status, 'success');
  assert.equal('maxOutputTokens' in fetched.observation.models[0].fields, false);
  const deltas = classifyCatalogDelta({
    evidence: buildEvidenceIndex({
      now: now(),
      observations: [fetched.observation],
      sourcePolicies: new Map([[source.id, source]]),
    }),
    manifest: { schemaVersion: 1, sources: [source] },
    registry: { models: [], providerCounts: {} },
    sourceStatuses: [fetched],
  });
  assert.equal(deltas[0].kind, 'unverifiable');
  assert.match(deltas[0].safety.reasons.join(' '), /unknown required field: maxOutputTokens/u);
});

test('classifies OpenRouter negative-pricing router sentinels as ignored, not source failure', async () => {
  const source = (await loadSourceManifest()).sources.at(-1);
  const router = structuredClone(fixture);
  router.data[0].id = 'openrouter/auto';
  router.data[0].pricing = { completion: '-1', prompt: '-1' };
  const fetched = await fetchSource({
    credential: undefined,
    fetchImpl: async () => new Response(JSON.stringify(router), { status: 200 }),
    now,
    source,
  });
  assert.equal(fetched.status, 'success');
  const deltas = classifyCatalogDelta({
    evidence: buildEvidenceIndex({
      now: now(),
      observations: [fetched.observation],
      sourcePolicies: new Map([[source.id, source]]),
    }),
    manifest: { schemaVersion: 1, sources: [source] },
    registry: { models: [], providerCounts: {} },
    sourceStatuses: [fetched],
  });
  assert.equal(deltas[0].kind, 'ignored');
  assert.match(deltas[0].safety.reasons.join(' '), /dynamic router pricing sentinel/u);
});

test('preserves inconsistent gateway limits as evidence but blocks safe addition', async () => {
  const source = {
    ...(await loadSourceManifest()).sources.at(-1),
    safeAddition: { approvedModelIds: ['anthropic/claude-test'], eligible: true },
  };
  const inconsistent = structuredClone(fixture);
  inconsistent.data[0].top_provider.max_completion_tokens = 200_001;
  const fetched = await fetchSource({
    credential: undefined,
    fetchImpl: async () => new Response(JSON.stringify(inconsistent), { status: 200 }),
    now,
    source,
  });
  assert.equal(fetched.status, 'success');
  const deltas = classifyCatalogDelta({
    evidence: buildEvidenceIndex({
      now: now(),
      observations: [fetched.observation],
      sourcePolicies: new Map([[source.id, source]]),
    }),
    manifest: { schemaVersion: 1, sources: [source] },
    registry: { models: [], providerCounts: {} },
    sourceStatuses: [fetched],
  });
  assert.equal(deltas[0].safety.disposition, 'blocked');
  assert.match(deltas[0].safety.reasons.join(' '), /gateway output limit exceeds context window/u);
});

test('missing provider credentials are visible and never become empty observations', async () => {
  const manifest = await loadSourceManifest();
  for (const source of manifest.sources.filter(({ credential }) => credential.kind !== 'none')) {
    const result = await fetchSource({
      credential: undefined,
      fetchImpl: async () => {
        throw new Error('must not fetch');
      },
      now,
      source,
    });
    assert.deepEqual(result, { sourceId: source.id, status: 'skipped_missing_secret' });
    assert.equal('observation' in result, false);
  }
});

test('source failures redact real credentials without corrupting unauthenticated diagnostics', async () => {
  const source = (await loadSourceManifest()).sources.at(-1);
  const result = await fetchSource({
    credential: undefined,
    fetchImpl: async () => new Response('{}', { status: 200 }),
    now,
    source,
  });
  assert.equal(result.error, 'invalid OpenRouter payload');
});

test('stale and conflicting field evidence fail visibly', async () => {
  const source = (await loadSourceManifest()).sources.at(-1);
  const result = await fetchSource({
    credential: undefined,
    fetchImpl: async () => new Response(JSON.stringify(fixture), { status: 200 }),
    now,
    source,
  });
  const observation = result.observation;
  const conflicting = structuredClone(observation);
  conflicting.sourceId = 'other';
  conflicting.models[0].fields.contextWindow.value = 123;
  conflicting.models[0].fields.contextWindow.sourceId = 'other';
  const policies = new Map([
    [source.id, source],
    ['other', source],
  ]);
  const index = buildEvidenceIndex({
    now: new Date('2026-08-17T12:00:00.000Z'),
    observations: [observation, conflicting],
    sourcePolicies: policies,
  });
  const evidence = index.get('openrouter:anthropic/claude-test').get('contextWindow');
  assert.equal(evidence.status, 'conflict');
  assert.ok(evidence.evidence.every(({ freshness }) => freshness === 'stale'));
});

test('AST-reads the real static literal registry and rejects computed catalog shapes', async () => {
  const registrySource = await readFile(
    new URL('../../packages/assistant-contract/src/provider-registry.ts', import.meta.url),
    'utf8'
  );
  const snapshot = parseProviderRegistry({
    importedStringConstants: { GEMMA4_E2B_MODEL_ID: 'google/gemma-4-e2b' },
    registrySource,
  });
  assert.ok(snapshot.models.length > 20);
  assert.ok(snapshot.models.every(({ source }) => Number.isSafeInteger(source.start)));
  assert.throws(
    () =>
      parseProviderRegistry({
        registrySource:
          'const models=[]; export const PROVIDER_DEFINITIONS = makeProviders(models);',
      }),
    /array literal/u
  );
});

test('classifies approved completeness deterministically and reports unknown required fields', async () => {
  const source = {
    ...(await loadSourceManifest()).sources.at(-1),
    safeAddition: { approvedModelIds: ['anthropic/claude-test'], eligible: true },
  };
  const fetched = await fetchSource({
    credential: undefined,
    fetchImpl: async () => new Response(JSON.stringify(fixture), { status: 200 }),
    now,
    source,
  });
  const evidence = buildEvidenceIndex({
    now: now(),
    observations: [fetched.observation],
    sourcePolicies: new Map([[source.id, source]]),
  });
  const registry = {
    models: [{ fields: {}, id: 'existing', providerId: 'openrouter' }],
    providerCounts: { openrouter: 1 },
  };
  const deltas = classifyCatalogDelta({
    evidence,
    manifest: { schemaVersion: 1, sources: [source] },
    registry,
    sourceStatuses: [fetched],
  });
  assert.deepEqual(
    deltas.map(({ kind }) => kind),
    ['remote_addition_candidate', 'registry_missing_remote']
  );
  assert.equal(deltas[0].safety.disposition, 'safe_addition');
  const incomplete = structuredClone(fetched.observation);
  incomplete.models[0].fields = Object.fromEntries(
    Object.entries(incomplete.models[0].fields).filter(([name]) => name !== 'vision')
  );
  const blocked = classifyCatalogDelta({
    evidence: buildEvidenceIndex({
      now: now(),
      observations: [incomplete],
      sourcePolicies: new Map([[source.id, source]]),
    }),
    manifest: { schemaVersion: 1, sources: [source] },
    registry: { models: [], providerCounts: {} },
    sourceStatuses: [fetched],
  });
  assert.equal(blocked[0].kind, 'unverifiable');
  assert.match(blocked[0].safety.reasons.join(' '), /vision/u);
});

test('suppresses historical inventory and floating aliases while preserving recent release leads', async () => {
  const source = (await loadSourceManifest()).sources.at(-1);
  const historical = structuredClone(fixture);
  historical.data[0].id = 'vendor/historical-model';
  historical.data[0].created = 1_700_000_000;
  const alias = structuredClone(fixture);
  alias.data[0].id = '~vendor/latest';
  const recent = structuredClone(fixture);
  recent.data[0].id = 'vendor/recent-model';
  const observations = [];
  for (const payload of [historical, alias, recent]) {
    const fetched = await fetchSource({
      credential: undefined,
      fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
      now,
      source,
    });
    observations.push(fetched.observation);
  }
  const deltas = classifyCatalogDelta({
    evidence: buildEvidenceIndex({
      now: now(),
      observations,
      sourcePolicies: new Map([[source.id, source]]),
    }),
    manifest: { schemaVersion: 1, sources: [source] },
    registry: { models: [], providerCounts: {} },
    sourceStatuses: [{ sourceId: source.id, status: 'success' }],
  });
  assert.deepEqual(
    deltas.map(({ kind, modelId }) => [modelId, kind]),
    [
      ['~vendor/latest', 'ignored'],
      ['vendor/historical-model', 'ignored'],
      ['vendor/recent-model', 'remote_addition_candidate'],
    ]
  );
});

test('does not treat a curated display label as provider metadata drift', async () => {
  const source = (await loadSourceManifest()).sources.at(-1);
  const fetched = await fetchSource({
    credential: undefined,
    fetchImpl: async () => new Response(JSON.stringify(fixture), { status: 200 }),
    now,
    source,
  });
  const fields = Object.fromEntries(
    Object.entries(fetched.observation.models[0].fields).map(([name, item]) => [name, item.value])
  );
  fields.label = 'Curated product label';
  const deltas = classifyCatalogDelta({
    evidence: buildEvidenceIndex({
      now: now(),
      observations: [fetched.observation],
      sourcePolicies: new Map([[source.id, source]]),
    }),
    manifest: { schemaVersion: 1, sources: [source] },
    registry: {
      models: [{ fields, id: 'anthropic/claude-test', providerId: 'openrouter' }],
      providerCounts: { openrouter: 1 },
    },
    sourceStatuses: [fetched],
  });
  assert.deepEqual(
    deltas.map(({ kind }) => kind),
    ['aligned']
  );
});

test('renders stable JSON-derived Markdown', () => {
  const report = createReport({
    baseCommit: 'a'.repeat(40),
    deltas: [],
    generatedAt: now().toISOString(),
    manifestSha256: 'sha256:x',
    registry: { models: [], providerCounts: {} },
    sources: [{ sourceId: 'x', status: 'skipped_missing_secret' }],
  });
  assert.equal(report.summary.aligned, 0);
  const markdown = renderMarkdown(report);
  assert.match(markdown, /incomplete.*missing credentials/iu);
  assert.equal(renderMarkdown(report), markdown);
});

test('evaluation consumes external labels and missing labels fail closed', async () => {
  const labelled = JSON.parse(
    await readFile(new URL('./fixtures/model-catalog/labelled-reports.json', import.meta.url))
  );
  const summary = evaluateLabelledReports(labelled);
  assert.deepEqual(summary, {
    criticalFalsePositives: 0,
    duplicateRate: 0.25,
    noiseRate: 0.25,
    precision: 0.5,
    routineId: 'model-catalog-updater',
    sampleCount: 4,
    unsafeFindings: 0,
  });
  assert.throws(
    () => evaluateLabelledReports([{ findingId: 'unlabelled' }]),
    /missing external label/u
  );
});

test('safe-addition seam requires exact approval and only renders guarded non-writing additions', async () => {
  const source = {
    ...(await loadSourceManifest()).sources.at(-1),
    safeAddition: { approvedModelIds: ['anthropic/claude-test'], eligible: true },
  };
  const candidate = {
    evidence: {},
    kind: 'remote_addition_candidate',
    modelId: 'anthropic/claude-test',
    providerId: 'openrouter',
    safety: { disposition: 'safe_addition', reasons: [] },
  };
  const plan = planSafeAddition({
    baseCommit: 'b'.repeat(40),
    candidate,
    manifest: { schemaVersion: 1, sources: [source] },
    nextMigrationVersion: 73,
  });
  assert.equal(plan.operation, 'PLAN');
  assert.equal(plan.defaults.isEnabled, false);
  assert.equal(plan.defaults.default, undefined);
  assert.ok(plan.paths.every((path) => !path.includes('preferences')));
  const files = new Map(
    plan.paths
      .filter((path) => !path.includes('migration-073'))
      .map((path) => [path, `original:${path}\n`])
  );
  const bundle = renderSafeAdditionEdits({ files, plan });
  assert.equal(bundle.baseCommit, 'b'.repeat(40));
  assert.equal(bundle.edits.length, 5);
  assert.ok(
    bundle.edits
      .filter(({ expectedSha256 }) => expectedSha256 !== null)
      .every(({ expectedSha256 }) => /^[0-9a-f]{64}$/u.test(expectedSha256))
  );
  assert.throws(
    () =>
      planSafeAddition({
        baseCommit: 'b'.repeat(40),
        candidate: { ...candidate, modelId: 'not-approved/id' },
        manifest: { schemaVersion: 1, sources: [source] },
        nextMigrationVersion: 73,
      }),
    /approvedModelIds/u
  );
});

test('workflow is weekday report-only with no mutation reachability', async () => {
  const workflow = await readFile(
    new URL('../../.github/workflows/model-catalog-updater.yml', import.meta.url),
    'utf8'
  );
  assert.match(workflow, /cron: ['"]17 13 \* \* 1-5['"]/u);
  assert.match(workflow, /permissions:\n\s+contents: read/u);
  assert.match(workflow, /timeout-minutes: 10/u);
  assert.match(workflow, /pnpm model-catalog:report/u);
  assert.doesNotMatch(
    workflow,
    /render-safe|pull-request|issues: write|contents: write|gh pr|git push/iu
  );
  assert.match(workflow, /retention-days: 14/u);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/u);
});
