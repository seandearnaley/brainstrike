import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CatalogProviderStat } from '../catalog-sections';
import { useCatalogExpansion } from '../use-catalog-expansion';

const stats: CatalogProviderStat[] = [
  { enabledCount: 1, providerId: 'openai', providerName: 'OpenAI', totalCount: 2 },
  { enabledCount: 0, providerId: 'anthropic', providerName: 'Anthropic', totalCount: 2 },
];

interface Props {
  readonly filtering: boolean;
  readonly providerStats: readonly CatalogProviderStat[];
  readonly visibleSectionIds: readonly string[];
}

describe('useCatalogExpansion', () => {
  it('seeds from enabled providers once data arrives, then follows filter sessions', () => {
    // Typed so renderHook's Props is not inferred from the `[]` literals (never[]).
    const initialProps: Props = { filtering: false, providerStats: [], visibleSectionIds: [] };
    const { rerender, result } = renderHook((props: Props) => useCatalogExpansion(props), {
      initialProps,
    });
    expect(result.current.expandedSectionIds.size).toBe(0);

    rerender({
      filtering: false,
      providerStats: stats,
      visibleSectionIds: ['openai', 'anthropic'],
    });
    expect([...result.current.expandedSectionIds]).toEqual(['openai']);

    rerender({ filtering: true, providerStats: stats, visibleSectionIds: ['anthropic'] });
    expect([...result.current.expandedSectionIds]).toEqual(['anthropic']);

    act(() => result.current.toggleSection('anthropic'));
    expect(result.current.expandedSectionIds.has('anthropic')).toBe(false);

    rerender({
      filtering: false,
      providerStats: stats,
      visibleSectionIds: ['openai', 'anthropic'],
    });
    expect([...result.current.expandedSectionIds]).toEqual(['openai']);
  });

  it('expands and collapses every visible section', () => {
    const { result } = renderHook(() =>
      useCatalogExpansion({
        filtering: false,
        providerStats: stats,
        visibleSectionIds: ['openai', 'anthropic'],
      })
    );
    act(() => result.current.expandAll());
    expect([...result.current.expandedSectionIds]).toEqual(['openai', 'anthropic']);
    act(() => result.current.collapseAll());
    expect(result.current.expandedSectionIds.size).toBe(0);
  });
});
