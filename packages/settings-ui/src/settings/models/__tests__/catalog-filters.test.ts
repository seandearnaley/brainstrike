import { describe, expect, it } from 'vitest';
import {
  type CatalogFilters,
  clearCatalogFilter,
  DEFAULT_CATALOG_FILTERS,
  describeActiveFilters,
  highlightSegments,
  isCatalogFilterActive,
  matchesCatalogFilters,
  parseContextBand,
  queryHitsIdOnly,
} from '../catalog-filters';
import { makeCatalogRow } from './catalog-test-harness';

function withFilters(overrides: Partial<CatalogFilters>): CatalogFilters {
  return { ...DEFAULT_CATALOG_FILTERS, ...overrides };
}

describe('matchesCatalogFilters', () => {
  it('matches everything under the defaults', () => {
    expect(matchesCatalogFilters(makeCatalogRow({ id: 'a' }), DEFAULT_CATALOG_FILTERS)).toBe(true);
  });

  it('filters by enabled status', () => {
    const on = makeCatalogRow({ enabled: true, id: 'on' });
    const off = makeCatalogRow({ enabled: false, id: 'off' });
    expect(matchesCatalogFilters(on, withFilters({ status: 'enabled' }))).toBe(true);
    expect(matchesCatalogFilters(off, withFilters({ status: 'enabled' }))).toBe(false);
    expect(matchesCatalogFilters(off, withFilters({ status: 'disabled' }))).toBe(true);
    expect(matchesCatalogFilters(on, withFilters({ status: 'disabled' }))).toBe(false);
  });

  it('filters by type, defaulting to all', () => {
    const chat = makeCatalogRow({ id: 'chat', type: 'chat' });
    const embedding = makeCatalogRow({ id: 'emb', type: 'embedding' });
    expect(matchesCatalogFilters(embedding, DEFAULT_CATALOG_FILTERS)).toBe(true);
    expect(matchesCatalogFilters(chat, withFilters({ type: 'embedding' }))).toBe(false);
    expect(matchesCatalogFilters(embedding, withFilters({ type: 'embedding' }))).toBe(true);
    expect(matchesCatalogFilters(embedding, withFilters({ type: 'chat' }))).toBe(false);
  });

  it('matches Vision only when vision is supported', () => {
    const filters = withFilters({ vision: true });
    expect(matchesCatalogFilters(makeCatalogRow({ id: 'y', vision: 'supported' }), filters)).toBe(
      true
    );
    expect(matchesCatalogFilters(makeCatalogRow({ id: 'n', vision: 'unsupported' }), filters)).toBe(
      false
    );
    expect(matchesCatalogFilters(makeCatalogRow({ id: 'u', vision: 'unknown' }), filters)).toBe(
      false
    );
    expect(matchesCatalogFilters(makeCatalogRow({ id: 'x', vision: null }), filters)).toBe(false);
  });

  it('never lets an unknown reasoning state satisfy Reasoning', () => {
    const filters = withFilters({ reasoning: true });
    expect(
      matchesCatalogFilters(
        makeCatalogRow({ id: 'y', reasoning: { source: 'model', state: 'supported' } }),
        filters
      )
    ).toBe(true);
    expect(
      matchesCatalogFilters(
        makeCatalogRow({
          id: 'u',
          reasoning: { reason: 'openrouter-undeclared', state: 'unknown' },
        }),
        filters
      )
    ).toBe(false);
    expect(matchesCatalogFilters(makeCatalogRow({ id: 'x', reasoning: null }), filters)).toBe(
      false
    );
  });

  it.each([
    ['128k', 127_999, false],
    ['128k', 128_000, true],
    ['200k', 199_999, false],
    ['200k', 200_000, true],
    ['1m', 999_999, false],
    ['1m', 1_000_000, true],
  ] as const)('context band %s at %i tokens → %s', (band, tokens, expected) => {
    expect(
      matchesCatalogFilters(
        makeCatalogRow({ contextWindow: tokens, id: 'm' }),
        withFilters({ context: band })
      )
    ).toBe(expected);
  });

  it('never matches a context band when the window is unpublished', () => {
    const row = makeCatalogRow({ contextWindow: null, id: 'm' });
    for (const band of ['128k', '200k', '1m'] as const) {
      expect(matchesCatalogFilters(row, withFilters({ context: band }))).toBe(false);
    }
    expect(matchesCatalogFilters(row, withFilters({ context: 'any' }))).toBe(true);
  });

  it('leaves the provider filter to the section buckets (buildCatalogView)', () => {
    const row = makeCatalogRow({ id: 'm', providerId: 'openai' });
    expect(matchesCatalogFilters(row, withFilters({ providerIds: new Set(['anthropic']) }))).toBe(
      true
    );
  });

  it('searches name, id, provider name, tagline and best-for tags with tokenised AND', () => {
    const row = makeCatalogRow({
      bestFor: ['Tool use'],
      id: 'claude-opus-5',
      name: 'Claude Opus 5',
      providerName: 'Anthropic',
      tagline: 'For complex agentic coding',
    });
    for (const query of ['claude opus', 'opus-5', 'anthropic', 'agentic', 'tool']) {
      expect(matchesCatalogFilters(row, withFilters({ query }))).toBe(true);
    }
    expect(matchesCatalogFilters(row, withFilters({ query: 'claude sonnet' }))).toBe(false);
  });

  it('composes every predicate with AND', () => {
    const row = makeCatalogRow({
      contextWindow: 1_000_000,
      enabled: true,
      id: 'm',
      vision: 'supported',
    });
    const all = withFilters({ context: '1m', reasoning: true, status: 'enabled', vision: true });
    expect(matchesCatalogFilters(row, all)).toBe(true);
    expect(matchesCatalogFilters({ ...row, enabled: false }, all)).toBe(false);
    expect(matchesCatalogFilters({ ...row, vision: 'unsupported' }, all)).toBe(false);
    expect(matchesCatalogFilters({ ...row, contextWindow: 200_000 }, all)).toBe(false);
  });
});

describe('isCatalogFilterActive', () => {
  it('is false for the defaults and a whitespace query', () => {
    expect(isCatalogFilterActive(DEFAULT_CATALOG_FILTERS)).toBe(false);
    expect(isCatalogFilterActive(withFilters({ query: '   ' }))).toBe(false);
  });

  it.each([
    [{ query: 'x' }],
    [{ status: 'enabled' as const }],
    [{ type: 'chat' as const }],
    [{ vision: true }],
    [{ reasoning: true }],
    [{ context: '1m' as const }],
    [{ providerIds: new Set(['openai']) }],
  ])('is true for %o', (overrides) => {
    expect(isCatalogFilterActive(withFilters(overrides))).toBe(true);
  });
});

describe('describeActiveFilters / clearCatalogFilter', () => {
  it('describes each active filter as a removable chip and clears it', () => {
    const filters = withFilters({
      context: '200k',
      providerIds: new Set(['openai']),
      query: ' claude ',
      reasoning: true,
      status: 'disabled',
      type: 'embedding',
      vision: true,
    });
    const chips = describeActiveFilters(filters, new Map([['openai', 'OpenAI']]));
    expect(chips).toEqual([
      { key: 'query', label: '"claude"' },
      { key: 'status', label: 'Disabled' },
      { key: 'type', label: 'Embedding' },
      { key: 'vision', label: 'Vision' },
      { key: 'reasoning', label: 'Reasoning' },
      { key: 'context', label: 'Context ≥ 200K' },
      { key: 'providers', label: 'OpenAI' },
    ]);
    let cleared = filters;
    for (const chip of chips) {
      cleared = clearCatalogFilter(cleared, chip.key);
    }
    expect(isCatalogFilterActive(cleared)).toBe(false);
  });

  it('summarises more than two providers by count', () => {
    const chips = describeActiveFilters(
      withFilters({ providerIds: new Set(['a', 'b', 'c']) }),
      new Map([
        ['a', 'A'],
        ['b', 'B'],
        ['c', 'C'],
      ])
    );
    expect(chips).toEqual([{ key: 'providers', label: '3 providers' }]);
  });

  it('fails loudly on a selected provider with no name, never rendering the raw id', () => {
    const names = new Map([['openai', 'OpenAI']]);
    expect(() =>
      describeActiveFilters(withFilters({ providerIds: new Set(['openai', 'retired']) }), names)
    ).toThrow('No provider name for selected provider: retired');
    expect(() =>
      describeActiveFilters(withFilters({ providerIds: new Set(['a', 'b', 'retired']) }), names)
    ).toThrow('No provider name for selected provider: a');
  });
});

describe('parseContextBand', () => {
  it('accepts every option and rejects anything else', () => {
    expect(parseContextBand('any')).toBe('any');
    expect(parseContextBand('1m')).toBe('1m');
    expect(() => parseContextBand('2m')).toThrow('Unknown context band: 2m');
  });
});

describe('queryHitsIdOnly', () => {
  const row = { id: 'anthropic/claude-opus-5', name: 'Claude Opus 5' };
  it('is true when a word hits the id but not the name', () => {
    expect(queryHitsIdOnly(row, 'anthropic/')).toBe(true);
    expect(queryHitsIdOnly(row, 'opus-5')).toBe(true);
  });
  it('is false when every hit is also in the name, or the query is empty', () => {
    expect(queryHitsIdOnly(row, 'claude opus')).toBe(false);
    expect(queryHitsIdOnly(row, '')).toBe(false);
  });
});

describe('highlightSegments', () => {
  it('marks every occurrence of every query word, case-insensitively', () => {
    expect(highlightSegments('Claude Opus', 'opus CLA')).toEqual([
      { match: true, start: 0, text: 'Cla' },
      { match: false, start: 3, text: 'ude ' },
      { match: true, start: 7, text: 'Opus' },
    ]);
  });
  it('returns one unmarked segment without a query', () => {
    expect(highlightSegments('Claude', '  ')).toEqual([{ match: false, start: 0, text: 'Claude' }]);
  });
  it('merges overlapping matches', () => {
    expect(highlightSegments('aaa', 'aa')).toEqual([{ match: true, start: 0, text: 'aaa' }]);
  });
});
