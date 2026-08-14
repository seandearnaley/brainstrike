import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { classifyCatalogDelta } from '../agent-routines/model-catalog/classify-catalog-delta.mjs';
import {
  assertLabelledReportsPromotionReady,
  evaluateLabelledReports,
  MODEL_CATALOG_PROMOTION_POLICY,
} from '../agent-routines/model-catalog/evaluator.mjs';
import { buildEvidenceIndex } from '../agent-routines/model-catalog/evidence.mjs';
import { parseProviderRegistry } from '../agent-routines/model-catalog/registry-reader.mjs';
import {
  createReport,
  modelCatalogFindingId,
  renderMarkdown,
} from '../agent-routines/model-catalog/report.mjs';
import { planSafeAddition } from '../agent-routines/model-catalog/safe-addition-plan.mjs';
import {
  loadSourceManifest,
  validateSourceManifest,
} from '../agent-routines/model-catalog/source-manifest.mjs';
import { fetchSource } from '../agent-routines/model-catalog/sources/index.mjs';
import { runModelCatalogMain } from '../agent-routines/model-catalog/update-model-catalog.mjs';
import { createRoutineResultWriter } from '../agent-routines/shared/routine-result.mjs';
import { canonicalReportId } from '../agent-routines/shared/shadow-report.mjs';

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
  assert.deepEqual(
    manifest.sources.map(({ required }) => required),
    [false, false, false, true]
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
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, source.url);
  assert.equal(calls[0].init.method, 'GET');
  assert.deepEqual(calls[0].init.headers, { accept: 'application/json' });
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(calls[0].init.signal.aborted, false);
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
    assert.deepEqual(result, {
      required: false,
      sourceId: source.id,
      status: 'skipped_missing_secret',
    });
    assert.equal('observation' in result, false);
  }
});

test('rejects unbounded, control-bearing, and non-grammar upstream model IDs', async () => {
  const source = (await loadSourceManifest()).sources.at(-1);
  for (const modelId of [
    'anthropic/bad|id',
    'anthropic/bad`id',
    'anthropic/bad\nheading',
    'anthropic//bad',
    `anthropic/${'x'.repeat(300)}`,
  ]) {
    const payload = structuredClone(fixture);
    payload.data[0].id = modelId;
    const result = await fetchSource({
      credential: undefined,
      fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
      now,
      source,
    });
    assert.equal(result.status, 'failed', modelId);
    assert.match(result.error, /invalid model ID/u);
  }
});

test('source requests abort at their configured deadline', async () => {
  const source = (await loadSourceManifest()).sources.at(-1);
  let observedSignal;
  const result = await fetchSource({
    credential: undefined,
    fetchImpl: async (_url, init) => {
      observedSignal = init.signal;
      return await new Promise((resolve, reject) => {
        const fallback = setTimeout(
          () => resolve(new Response(JSON.stringify(fixture), { status: 200 })),
          100
        );
        init.signal?.addEventListener('abort', () => {
          clearTimeout(fallback);
          reject(init.signal.reason);
        });
      });
    },
    now,
    source,
    timeoutMs: 5,
  });
  assert.ok(observedSignal instanceof AbortSignal);
  assert.equal(observedSignal.aborted, true);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /timed out/u);
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
  for (const registrySource of [
    "const PROVIDER_DEFINITIONS = [{ id: 'p', models: [{ id: 'm', label: makeLabel(), type: 'llm' }] }];",
    "const PROVIDER_DEFINITIONS = [{ id: 'p', models: [{ id: UNKNOWN, type: 'llm' }] }];",
    "const PROVIDER_DEFINITIONS = [{ id: 'p', models: [{ ['id']: 'm', type: 'llm' }] }];",
    "const extra = {}; const PROVIDER_DEFINITIONS = [{ id: 'p', models: [{ ...extra, id: 'm', type: 'llm' }] }];",
    "const PROVIDER_DEFINITIONS = [{ id: 'p', models: [{ id: 'm', id: 'other', type: 'llm' }] }];",
  ]) {
    assert.throws(
      () => parseProviderRegistry({ registrySource }),
      /unsupported|duplicate|unresolved/u
    );
  }
});

test('registry reader rejects every TypeScript parse diagnostic', () => {
  const malformedSources = [
    "const PROVIDER_DEFINITIONS = [{ id: 'p' models: [] }];",
    "const PROVIDER_DEFINITIONS = [{ id: 'p', models: [] }]; trailing garbage",
    "const PROVIDER_DEFINITIONS = [{ id: 'p', models: [",
  ];
  for (const registrySource of malformedSources) {
    assert.throws(
      () => parseProviderRegistry({ registrySource }),
      /TypeScript parse diagnostics/u,
      registrySource
    );
  }
});

test('OpenRouter-only evidence cannot authorize vendor-owned catalog fields', async () => {
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
  assert.equal(deltas[0].safety.disposition, 'report_only');
  assert.match(
    deltas[0].safety.reasons.join(' '),
    /first-party vendor evidence.*contextWindow.*maxOutputTokens.*vision/u
  );
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

test('forged OpenRouter vendor authority cannot authorize vendor-owned fields', async () => {
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
  for (const field of ['contextWindow', 'maxOutputTokens', 'vision']) {
    fetched.observation.models[0].fields[field].authority = 'vendor';
  }

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

  assert.equal(deltas[0].safety.disposition, 'report_only');
  assert.match(deltas[0].safety.reasons.join(' '), /first-party vendor evidence/u);
});

test('safeAddition.eligible false blocks classification even with exact approval', async () => {
  const source = {
    ...(await loadSourceManifest()).sources.at(-1),
    safeAddition: { approvedModelIds: ['anthropic/claude-test'], eligible: false },
  };
  const fetched = await fetchSource({
    credential: undefined,
    fetchImpl: async () => new Response(JSON.stringify(fixture), { status: 200 }),
    now,
    source,
  });
  for (const field of ['contextWindow', 'maxOutputTokens', 'vision']) {
    fetched.observation.models[0].fields[field].authority = 'vendor';
  }
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
  assert.equal(deltas[0].safety.disposition, 'report_only');
  assert.match(deltas[0].safety.reasons.join(' '), /source is not eligible for safe additions/u);
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

test('OpenRouter route evidence is not authoritative drift for vendor-owned fields', async () => {
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
  fields.contextWindow = 1;
  fields.maxOutputTokens = 2;
  fields.vision = 'unsupported';

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

test('model catalog reports assign stable finding provenance IDs', () => {
  const delta = {
    field: 'vision',
    kind: 'field_drift',
    modelId: 'model/id',
    providerId: 'openrouter',
    safety: { disposition: 'report_only', reasons: [] },
  };
  const input = {
    baseCommit: 'a'.repeat(40),
    deltas: [delta],
    generatedAt: now().toISOString(),
    manifestSha256: 'sha256:x',
    registry: { models: [], providerCounts: {} },
    sources: [],
  };

  const first = createReport(input);
  const second = createReport(input);
  assert.equal(first.deltas[0].findingId, second.deltas[0].findingId);
  assert.ok(first.deltas[0].findingId.length > 0);
  assert.equal('findingId' in delta, false);
});

test('renders stable JSON-derived Markdown', () => {
  const report = createReport({
    baseCommit: 'a'.repeat(40),
    deltas: [],
    generatedAt: now().toISOString(),
    manifestSha256: 'sha256:x',
    registry: { models: [], providerCounts: {} },
    sources: [{ required: false, sourceId: 'x', status: 'skipped_missing_secret' }],
  });
  assert.equal(report.summary.aligned, 0);
  const markdown = renderMarkdown(report);
  assert.match(
    markdown,
    /complete.*optional sources were skipped because credentials are absent/iu
  );
  assert.equal(renderMarkdown(report), markdown);
});

test('attempted optional source failures render the report as incomplete', () => {
  const report = createReport({
    baseCommit: 'a'.repeat(40),
    deltas: [],
    generatedAt: now().toISOString(),
    manifestSha256: 'sha256:x',
    registry: { models: [], providerCounts: {} },
    sources: [{ required: false, sourceId: 'optional', status: 'failed' }],
  });

  const markdown = renderMarkdown(report);
  assert.match(markdown, /Incomplete.*attempted optional source failed/iu);
  assert.doesNotMatch(markdown, /all configured sources were observed/iu);
});

test('required failures remain incomplete and Markdown escapes all external identifiers', () => {
  const report = createReport({
    baseCommit: 'a'.repeat(40),
    deltas: [
      {
        kind: 'remote_addition_candidate',
        modelId: 'model`\n## injected',
        providerId: 'provider|cell',
        safety: { disposition: 'report_only', reasons: [] },
      },
    ],
    generatedAt: now().toISOString(),
    manifestSha256: 'sha256:x',
    registry: { models: [], providerCounts: {} },
    sources: [{ required: true, sourceId: 'required|source', status: 'failed' }],
  });
  const markdown = renderMarkdown(report);
  assert.match(markdown, /Incomplete.*required source failed/u);
  assert.doesNotMatch(markdown, /\n## injected/u);
  assert.match(markdown, /required\\\|source/u);
  assert.match(markdown, /provider\\\|cell/u);
});

test('promotion labels are bound to disjoint validated report findings', () => {
  const artifact = (baseCharacter, modelIds) => {
    const deltas = modelIds.map((modelId) => {
      const delta = { kind: 'field_drift', modelId, providerId: 'provider-1' };
      return { ...delta, findingId: modelCatalogFindingId(delta) };
    });
    const report = {
      baseCommit: baseCharacter.repeat(40),
      deltas,
      mode: 'report',
      routineId: 'model-catalog-updater',
      schemaVersion: 1,
    };
    return {
      report,
      reportId: canonicalReportId(report),
      routineId: report.routineId,
    };
  };
  const real = artifact('a', ['real']);

  assert.throws(
    () =>
      evaluateLabelledReports({
        labels: [
          {
            findingId: 'invented',
            label: 'correct_actionable',
            reportId: real.reportId,
          },
        ],
        reports: [real],
      }),
    /labels do not match report findings/u
  );
  for (const reports of [
    [artifact('a', ['duplicate', 'duplicate'])],
    [artifact('a', ['shared']), artifact('b', ['shared'])],
  ]) {
    assert.throws(
      () => evaluateLabelledReports({ labels: [], reports }),
      /finding IDs are empty, duplicated, or shared/u
    );
  }
});

test('model promotion rejects fabricated report artifacts', () => {
  const delta = {
    field: 'contextWindow',
    findingId: '',
    kind: 'field_drift',
    modelId: 'model-1',
    providerId: 'provider-1',
  };
  delta.findingId = modelCatalogFindingId(delta);
  const report = {
    baseCommit: 'a'.repeat(40),
    deltas: [delta],
    mode: 'report',
    routineId: 'model-catalog-updater',
    schemaVersion: 1,
  };
  const reportId = canonicalReportId(report);
  const evaluation = {
    labels: [{ findingId: delta.findingId, label: 'correct_actionable', reportId }],
    reports: [{ report, reportId, routineId: 'model-catalog-updater' }],
  };

  assert.doesNotThrow(() => evaluateLabelledReports(evaluation));
  for (const artifact of [
    { ...evaluation.reports[0], reportId: 'caller-invented' },
    { ...evaluation.reports[0], report: { ...report, baseCommit: 'A'.repeat(40) } },
    { ...evaluation.reports[0], report: { ...report, deltas: [] } },
    { ...evaluation.reports[0], report: { ...report, routineId: 'unknown-routine' } },
  ]) {
    assert.throws(
      () => evaluateLabelledReports({ ...evaluation, reports: [artifact] }),
      /report artifacts/u
    );
  }
});

test('model promotion recomputes finding IDs from delta identity', () => {
  const delta = {
    findingId: 'caller-invented',
    kind: 'remote_addition_candidate',
    modelId: 'model-1',
    providerId: 'provider-1',
  };
  const report = {
    baseCommit: 'a'.repeat(40),
    deltas: [delta],
    mode: 'report',
    routineId: 'model-catalog-updater',
    schemaVersion: 1,
  };
  const reportId = canonicalReportId(report);

  assert.throws(
    () =>
      evaluateLabelledReports({
        labels: [{ findingId: delta.findingId, label: 'correct_actionable', reportId }],
        reports: [{ report, reportId, routineId: report.routineId }],
      }),
    /finding IDs/u
  );
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
    reportCount: 4,
    routineId: 'model-catalog-updater',
    sampleCount: 4,
    unsafeFindings: 0,
  });
  assert.throws(
    () => assertLabelledReportsPromotionReady(MODEL_CATALOG_PROMOTION_POLICY, labelled),
    /not promotion-ready/u
  );
  assert.throws(
    () => evaluateLabelledReports({ labels: [], reports: [labelled.reports[0]] }),
    /missing external label/u
  );
});

test('safe-addition seam requires eligibility and returns evidence only', async () => {
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
  assert.equal(plan.operation, 'EVIDENCE_PLAN');
  assert.equal(plan.writes, false);
  assert.equal(plan.defaults.isEnabled, false);
  assert.equal(plan.defaults.default, undefined);
  assert.deepEqual(plan.requiredHumanWork, [
    'author and review static registry entry',
    'author both migration registrations and faithful down migration',
    'author and run real PGlite migration coverage',
  ]);
  assert.equal('paths' in plan, false);
  assert.equal('edits' in plan, false);
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
  assert.throws(
    () =>
      planSafeAddition({
        baseCommit: 'b'.repeat(40),
        candidate,
        manifest: {
          schemaVersion: 1,
          sources: [{ ...source, safeAddition: { ...source.safeAddition, eligible: false } }],
        },
        nextMigrationVersion: 73,
      }),
    /eligible/u
  );
});

test('model catalog main blocks once when an attempted optional source fails', async () => {
  const baseSha = 'a'.repeat(40);
  const lines = [];
  const exitCodes = [];
  const terminalWriter = createRoutineResultWriter((line) => lines.push(line));

  const result = await runModelCatalogMain({
    freezeMain: async () => baseSha,
    readHead: async () => baseSha,
    runReport: async () => ({
      attemptedOptionalSourceFailed: true,
      report: {
        sources: [
          { required: false, sourceId: 'optional', status: 'failed' },
          { required: true, sourceId: 'required', status: 'success' },
        ],
        summary: {
          conflict: 0,
          fieldDrift: 0,
          registryMissingRemote: 0,
          remoteAdditionCandidate: 0,
          unverifiable: 0,
        },
      },
      requiredSourceFailed: false,
    }),
    setExitCode: (code) => exitCodes.push(code),
    terminalWriter,
  });

  assert.equal(lines.length, 1);
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.reasons, ['attempted optional model-catalog source failed']);
  assert.deepEqual(exitCodes, [1]);
  assert.deepEqual(JSON.parse(lines[0]), result);
});

test('model catalog main emits one blocked result when diagnostic writes fail', async () => {
  const baseSha = 'a'.repeat(40);
  const lines = [];
  const terminalWriter = createRoutineResultWriter((line) => lines.push(line));

  const result = await runModelCatalogMain({
    freezeMain: async () => baseSha,
    readHead: async () => baseSha,
    runReport: async () => {
      throw new Error('primary catalog failure');
    },
    terminalWriter,
    writeDiagnostic: async () => {
      throw new Error('diagnostic failed at /private/secret-path');
    },
  });

  assert.equal(lines.length, 1);
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.reasons, [
    'Error: primary catalog failure',
    'diagnostic report write failed',
  ]);
  assert.deepEqual(JSON.parse(lines[0]), result);
  assert.doesNotMatch(lines[0], /secret-path/u);
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
  assert.match(workflow, /name: Generate report\n\s+if: github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /ref: refs\/heads\/main/u);
  assert.match(workflow, /uses: \.\/\.github\/actions\/setup-report-workspace/u);
  assert.doesNotMatch(workflow, /setup-workspace|actions\/cache|turbo-cache/u);
  assert.doesNotMatch(
    workflow,
    /render-safe|pull-request|issues: write|contents: write|gh pr|git push/iu
  );
  assert.match(workflow, /retention-days: 14/u);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/u);
});
