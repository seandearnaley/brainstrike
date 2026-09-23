import { describe, expect, it } from 'vitest';
import { createCatalogProjector, projectCatalogRow } from '../catalog-projection';
import { makeDbModel } from './catalog-test-harness';

describe('projectCatalogRow', () => {
  it('joins the registry facts for a registered chat model', () => {
    const row = projectCatalogRow(
      makeDbModel({
        id: 'gpt-5.6-terra',
        isEnabled: true,
        name: 'GPT-5.6 Terra',
        providerId: 'openai',
        tagline: 'Most capable for everyday work',
      }),
      'OpenAI'
    );
    expect(row).toMatchObject({
      contextWindow: 1_050_000,
      enabled: true,
      isLocal: false,
      maxOutputTokens: 128_000,
      name: 'GPT-5.6 Terra',
      pricing: {
        cacheReadPerMTok: null,
        cacheWritePerMTok: null,
        inputPerMTok: 2.5,
        outputPerMTok: 15,
      },
      providerName: 'OpenAI',
      recommended: true,
      registered: true,
      tagline: 'Most capable for everyday work',
      type: 'chat',
      vision: 'supported',
    });
    expect(row.reasoning?.state).toBe('supported');
  });

  it('carries cache pricing and the offered effort ladder', () => {
    const row = projectCatalogRow(
      makeDbModel({ id: 'claude-opus-5', name: 'Claude Opus 5', providerId: 'anthropic' }),
      'Anthropic'
    );
    expect(row.pricing).toEqual({
      cacheReadPerMTok: 0.5,
      cacheWritePerMTok: 6.25,
      inputPerMTok: 5,
      outputPerMTok: 25,
    });
    expect(row.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('keeps an unpriced model null, never 0', () => {
    const row = projectCatalogRow(
      makeDbModel({ id: 'onnx-community/gemma-4-E2B-it-ONNX', providerId: 'local' }),
      'Local'
    );
    expect(row.pricing).toBeNull();
    expect(row.contextWindow).toBe(8192);
    expect(row.isLocal).toBe(true);
  });

  it('gives a DB-only row no registry facts at all', () => {
    const row = projectCatalogRow(
      makeDbModel({
        capabilities: { defaultDimension: 384, type: 'embedding' },
        id: 'Xenova/all-MiniLM-L6-v2',
        providerId: 'transformers',
      }),
      'Transformers.js'
    );
    expect(row).toMatchObject({
      contextWindow: null,
      dimension: 384,
      isLocal: true,
      maxOutputTokens: null,
      pricing: null,
      reasoning: null,
      reasoningEfforts: null,
      recommended: false,
      registered: false,
      type: 'embedding',
      vision: null,
    });
  });

  it('gives a chat row under a provider missing from the registry no signal at all', () => {
    const row = projectCatalogRow(
      makeDbModel({ capabilities: { type: 'llm' }, id: 'old-chat', providerId: 'retired' }),
      'Unknown provider'
    );
    expect(row).toMatchObject({
      contextWindow: null,
      pricing: null,
      reasoning: null,
      reasoningEfforts: null,
      registered: false,
      type: 'chat',
      vision: null,
    });
  });

  it('preserves an unknown reasoning state instead of coercing it', () => {
    const row = projectCatalogRow(
      makeDbModel({ id: 'openai/gpt-6-astra', providerId: 'openrouter' }),
      'OpenRouter'
    );
    expect(row.reasoning).toEqual({ reason: 'openrouter-undeclared', state: 'unknown' });
    expect(row.reasoningEfforts).toBeNull();
  });

  it('reads embedding dimensions and the registry default flag', () => {
    const row = projectCatalogRow(
      makeDbModel({
        capabilities: { defaultDimension: 1536, type: 'embedding' },
        id: 'text-embedding-3-small',
        providerId: 'openai',
      }),
      'OpenAI'
    );
    expect(row).toMatchObject({
      contextWindow: null,
      dimension: 1536,
      reasoning: null,
      recommended: true,
      type: 'embedding',
      vision: null,
    });
  });

  it('reads the size label and best-for tags from the DB row', () => {
    const row = projectCatalogRow(
      makeDbModel({
        bestFor: ['Coding', 'Tool use'],
        id: 'onnx-community/gemma-4-E2B-it-ONNX',
        parameters: { size: '1.2 GB' },
        providerId: 'local',
      }),
      'Local'
    );
    expect(row.sizeLabel).toBe('1.2 GB');
    expect(row.bestFor).toEqual(['Coding', 'Tool use']);
  });
});

describe('createCatalogProjector', () => {
  it('returns the same row for the same DbModel identity', () => {
    const project = createCatalogProjector();
    const model = makeDbModel({ id: 'gpt-5.6-terra', providerId: 'openai' });
    expect(project(model, 'OpenAI')).toBe(project(model, 'OpenAI'));
  });

  it('re-projects only a replaced DbModel (a toggle)', () => {
    const project = createCatalogProjector();
    const a = makeDbModel({ id: 'gpt-5.6-terra', providerId: 'openai' });
    const b = makeDbModel({ id: 'gpt-5.5', providerId: 'openai' });
    const aRow = project(a, 'OpenAI');
    const bRow = project(b, 'OpenAI');
    const toggledA = { ...a, isEnabled: true };
    const toggledRow = project(toggledA, 'OpenAI');
    expect(toggledRow).not.toBe(aRow);
    expect(toggledRow.enabled).toBe(true);
    expect(project(b, 'OpenAI')).toBe(bRow);
  });

  it('re-projects when the provider name changes', () => {
    const project = createCatalogProjector();
    const model = makeDbModel({ id: 'gpt-5.6-terra', providerId: 'openai' });
    const first = project(model, 'OpenAI');
    expect(project(model, 'OpenAI (renamed)')).not.toBe(first);
  });
});
