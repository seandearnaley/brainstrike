// @vitest-environment node
import { findLlmModelDefinition } from '@brainstrike/assistant-contract/provider-registry';
import { describe, expect, it } from 'vitest';
import { createCatalogProjector, projectCatalogRow } from '../catalog-projection';
import { makeDbModel } from './catalog-test-harness';

const NOV_20_2026 = Date.UTC(2026, 10, 20);
const DEC_1_2026 = Date.UTC(2026, 11, 1);

describe('projectCatalogRow', () => {
  it('joins the registry facts for a registered chat model', () => {
    // Prices come from the registry: catalog re-pricing must not break the join.
    const terraPricing = findLlmModelDefinition('openai', 'gpt-6.1-terra')?.pricing;
    expect(terraPricing).toBeDefined();
    const row = projectCatalogRow(
      makeDbModel({
        id: 'gpt-6.1-terra',
        isEnabled: true,
        name: 'GPT-6.1 Terra',
        providerId: 'openai',
        tagline: 'Balanced GPT-6.1 tier',
      }),
      'OpenAI',
      NOV_20_2026
    );
    expect(row).toMatchObject({
      contextWindow: 1_050_000,
      enabled: true,
      maxOutputTokens: 128_000,
      name: 'GPT-6.1 Terra',
      pricing: {
        cacheReadPerMTok: terraPricing?.cacheReadPerMTok,
        cacheWritePerMTok: terraPricing?.cacheWritePerMTok,
        inputPerMTok: terraPricing?.inputPerMTok,
        nextChange: null,
        outputPerMTok: terraPricing?.outputPerMTok,
      },
      providerName: 'OpenAI',
      recommended: true,
      registered: true,
      tagline: 'Balanced GPT-6.1 tier',
      vision: 'supported',
    });
    expect(row.reasoning?.state).toBe('supported');
  });

  it('carries cache pricing and the offered effort ladder', () => {
    const row = projectCatalogRow(
      makeDbModel({ id: 'claude-opus-5', name: 'Claude Opus 5', providerId: 'anthropic' }),
      'Anthropic',
      NOV_20_2026
    );
    expect(row.pricing).toEqual({
      cacheReadPerMTok: 0.5,
      cacheWritePerMTok: 6.25,
      inputPerMTok: 5,
      nextChange: null,
      outputPerMTok: 25,
    });
    expect(row.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('shows the rates in force when the catalog opened, and the change Google announced', () => {
    const argon = makeDbModel({ id: 'gemini-4-argon', providerId: 'google' });
    const change = {
      cacheReadPerMTok: 0.2,
      cacheWritePerMTok: null,
      effectiveFrom: '2026-12-01',
      inputPerMTok: 4,
      outputPerMTok: 20,
    };
    expect(projectCatalogRow(argon, 'Google AI Studio', NOV_20_2026).pricing).toEqual({
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: null,
      inputPerMTok: 2,
      nextChange: change,
      outputPerMTok: 10,
    });
    const { effectiveFrom: _day, ...inForce } = change;
    expect(projectCatalogRow(argon, 'Google AI Studio', DEC_1_2026).pricing).toEqual({
      ...inForce,
      nextChange: null,
    });
  });

  it('gives a DB-only row no registry facts at all', () => {
    const row = projectCatalogRow(
      makeDbModel({ id: 'retired-model', providerId: 'openai' }),
      'OpenAI',
      NOV_20_2026
    );
    expect(row).toMatchObject({
      contextWindow: null,
      maxOutputTokens: null,
      pricing: null,
      recommended: false,
      registered: false,
      vision: null,
    });
  });

  it('gives a chat row under a provider missing from the registry no signal at all', () => {
    const row = projectCatalogRow(
      makeDbModel({ capabilities: { type: 'llm' }, id: 'old-chat', providerId: 'retired' }),
      'Unknown provider',
      NOV_20_2026
    );
    expect(row).toMatchObject({
      contextWindow: null,
      pricing: null,
      reasoning: null,
      reasoningEfforts: null,
      registered: false,
      vision: null,
    });
  });

  it('preserves an unknown reasoning state instead of coercing it', () => {
    const row = projectCatalogRow(
      makeDbModel({ id: 'openai/gpt-6-astra', providerId: 'openrouter' }),
      'OpenRouter',
      NOV_20_2026
    );
    expect(row.reasoning).toEqual({ reason: 'openrouter-undeclared', state: 'unknown' });
    expect(row.reasoningEfforts).toBeNull();
  });

  it('reads the best-for tags from the DB row', () => {
    const row = projectCatalogRow(
      makeDbModel({
        bestFor: ['Coding', 'Tool use'],
        id: 'gpt-5.6-terra',
        providerId: 'openai',
      }),
      'OpenAI',
      NOV_20_2026
    );
    expect(row.bestFor).toEqual(['Coding', 'Tool use']);
  });
});

describe('createCatalogProjector', () => {
  it('returns the same row for the same DbModel identity', () => {
    const project = createCatalogProjector(NOV_20_2026);
    const model = makeDbModel({ id: 'gpt-5.6-terra', providerId: 'openai' });
    expect(project(model, 'OpenAI')).toBe(project(model, 'OpenAI'));
  });

  it('re-projects only a replaced DbModel (a toggle)', () => {
    const project = createCatalogProjector(NOV_20_2026);
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
    const project = createCatalogProjector(NOV_20_2026);
    const model = makeDbModel({ id: 'gpt-5.6-terra', providerId: 'openai' });
    const first = project(model, 'OpenAI');
    expect(project(model, 'OpenAI (renamed)')).not.toBe(first);
  });
});
