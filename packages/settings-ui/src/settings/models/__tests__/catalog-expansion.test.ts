import { describe, expect, it } from 'vitest';
import {
  type CatalogExpansionState,
  collapseAllCatalogSections,
  defaultManualExpansion,
  expandAllCatalogSections,
  INITIAL_CATALOG_EXPANSION,
  reconcileCatalogExpansion,
  resolveExpandedSections,
  toggleCatalogSection,
} from '../catalog-expansion';
import type { CatalogProviderStat } from '../catalog-sections';

function stat(providerId: string, enabledCount: number): CatalogProviderStat {
  return { enabledCount, providerId, providerName: providerId, totalCount: 5 };
}

const stats = [stat('openai', 3), stat('anthropic', 0), stat('openrouter', 1)];

describe('defaultManualExpansion', () => {
  it('expands every provider with an enabled model', () => {
    expect([...defaultManualExpansion(stats)]).toEqual(['openai', 'openrouter']);
  });
  it('expands the first provider when nothing is enabled anywhere', () => {
    expect([...defaultManualExpansion([stat('a', 0), stat('b', 0)])]).toEqual(['a']);
  });
  it('expands nothing for an empty catalog', () => {
    expect(defaultManualExpansion([]).size).toBe(0);
  });
});

describe('reconcileCatalogExpansion', () => {
  it('returns the SAME object when nothing changes, so a render-phase adjust converges', () => {
    const seeded = reconcileCatalogExpansion(INITIAL_CATALOG_EXPANSION, stats, false);
    expect(reconcileCatalogExpansion(seeded, stats, false)).toBe(seeded);
    const inSession = reconcileCatalogExpansion(seeded, stats, true);
    expect(reconcileCatalogExpansion(inSession, stats, true)).toBe(inSession);
  });

  it('waits for providers before seeding, then seeds once', () => {
    expect(reconcileCatalogExpansion(INITIAL_CATALOG_EXPANSION, [], false)).toBe(
      INITIAL_CATALOG_EXPANSION
    );
    const seeded = reconcileCatalogExpansion(INITIAL_CATALOG_EXPANSION, stats, false);
    const collapsedByUser: CatalogExpansionState = { ...seeded, manual: new Set<string>() };
    expect(reconcileCatalogExpansion(collapsedByUser, stats, false)).toBe(collapsedByUser);
  });

  it('seeds from unfiltered stats even when the first render is already filtering', () => {
    const state = reconcileCatalogExpansion(INITIAL_CATALOG_EXPANSION, stats, true);
    expect([...(state.manual ?? [])]).toEqual(['openai', 'openrouter']);
    expect(state.sessionCollapsed?.size).toBe(0);
  });
});

describe('filter sessions', () => {
  const seeded = reconcileCatalogExpansion(INITIAL_CATALOG_EXPANSION, stats, false);

  it('expands every matching section while filtering', () => {
    const session = reconcileCatalogExpansion(seeded, stats, true);
    expect([...resolveExpandedSections(session, ['anthropic', 'openrouter'], true)]).toEqual([
      'anthropic',
      'openrouter',
    ]);
  });

  it('keeps a section collapsed for the rest of the session, then restores the manual set', () => {
    let state = reconcileCatalogExpansion(seeded, stats, true);
    state = toggleCatalogSection(state, 'anthropic', true);
    // A query change inside the same session: still collapsed.
    expect(resolveExpandedSections(state, ['anthropic', 'openai'], true).has('anthropic')).toBe(
      false
    );
    // Clearing the filters ends the session; the manual set was never touched.
    state = reconcileCatalogExpansion(state, stats, false);
    expect(state.sessionCollapsed).toBeNull();
    expect([
      ...resolveExpandedSections(state, ['openai', 'anthropic', 'openrouter'], false),
    ]).toEqual(['openai', 'openrouter']);
    // A new session starts fresh.
    state = reconcileCatalogExpansion(state, stats, true);
    expect(resolveExpandedSections(state, ['anthropic'], true).has('anthropic')).toBe(true);
  });
});

describe('Expand all / Collapse all', () => {
  const seeded = reconcileCatalogExpansion(INITIAL_CATALOG_EXPANSION, stats, false);
  const all = ['openai', 'anthropic', 'openrouter'];

  it('act on the manual set when not filtering', () => {
    const expanded = expandAllCatalogSections(seeded, all, false);
    expect([...resolveExpandedSections(expanded, all, false)]).toEqual(all);
    const collapsed = collapseAllCatalogSections(expanded, all, false);
    expect(resolveExpandedSections(collapsed, all, false).size).toBe(0);
  });

  it('act on the session while filtering and leave the manual set alone', () => {
    const session = reconcileCatalogExpansion(seeded, stats, true);
    const collapsed = collapseAllCatalogSections(session, ['anthropic'], true);
    expect(resolveExpandedSections(collapsed, ['anthropic'], true).size).toBe(0);
    expect(collapsed.manual).toBe(seeded.manual);
    const expanded = expandAllCatalogSections(collapsed, ['anthropic'], true);
    expect([...resolveExpandedSections(expanded, ['anthropic'], true)]).toEqual(['anthropic']);
  });

  it('toggles the manual set when not filtering', () => {
    const toggled = toggleCatalogSection(seeded, 'anthropic', false);
    expect(resolveExpandedSections(toggled, all, false).has('anthropic')).toBe(true);
    expect(
      resolveExpandedSections(toggleCatalogSection(toggled, 'anthropic', false), all, false).has(
        'anthropic'
      )
    ).toBe(false);
  });
});
