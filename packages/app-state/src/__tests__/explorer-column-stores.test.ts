/**
 * Explorer tree-grid column preferences (BST-1208).
 *
 * Two stores, deliberately separate: widths (sanitized by the shared TreeTable
 * factory) and visibility (a preference with shipped defaults). These tests pin
 * the decision-D1 defaults, the bounds the column definitions are derived from,
 * and that a malformed persisted payload falls back to the defaults rather than
 * hiding a column the user never hid.
 */
import { describe, expect, it } from 'vitest';
import {
  EXPLORER_COLUMN_BOUNDS,
  useExplorerColumnSizesStore,
} from '../stores/explorer-column-sizes-store';
import {
  EXPLORER_METADATA_COLUMN_IDS,
  sanitizeExplorerColumnVisibility,
  useExplorerColumnVisibilityStore,
} from '../stores/explorer-column-visibility-store';
import {
  sanitizeExplorerSortState,
  useExplorerSortStateStore,
} from '../stores/explorer-sort-state-store';

describe('explorer column sizes store', () => {
  it('carries bounds for the metadata columns only — name is the pinned tree column', () => {
    expect(Object.keys(EXPLORER_COLUMN_BOUNDS).sort()).toEqual([
      'size',
      'thread',
      'tokens',
      'type',
    ]);
  });

  it('declares every bound with default within [min, max]', () => {
    for (const bounds of Object.values(EXPLORER_COLUMN_BOUNDS)) {
      expect(bounds.minWidth).toBeLessThanOrEqual(bounds.defaultWidth);
      expect(bounds.defaultWidth).toBeLessThanOrEqual(bounds.maxWidth);
    }
  });

  it('seeds every metadata column with its default width', () => {
    expect(useExplorerColumnSizesStore.getState().sizes).toEqual({
      size: EXPLORER_COLUMN_BOUNDS.size.defaultWidth,
      thread: EXPLORER_COLUMN_BOUNDS.thread.defaultWidth,
      tokens: EXPLORER_COLUMN_BOUNDS.tokens.defaultWidth,
      type: EXPLORER_COLUMN_BOUNDS.type.defaultWidth,
    });
  });

  it('clamps an out-of-bounds resize instead of accepting it', () => {
    useExplorerColumnSizesStore.getState().setColumn('tokens', 10_000);
    expect(useExplorerColumnSizesStore.getState().sizes['tokens']).toBe(
      EXPLORER_COLUMN_BOUNDS.tokens.maxWidth
    );
    useExplorerColumnSizesStore.getState().reset();
  });
});

describe('explorer column visibility store', () => {
  it('ships Tokens and This thread visible, Type/Size opt-in (decision D1)', () => {
    // Projected through EXPLORER_METADATA_COLUMN_IDS and compared with toEqual,
    // not toMatchObject against live store state: a new metadata column must
    // fail this test rather than default itself in unnoticed.
    const state = useExplorerColumnVisibilityStore.getState();
    const shippedDefaults = Object.fromEntries(
      EXPLORER_METADATA_COLUMN_IDS.map((columnId) => [columnId, state[columnId]])
    );

    expect(shippedDefaults).toEqual({
      size: false,
      thread: true,
      tokens: true,
      type: false,
    });
  });

  it('never exposes `name` as a hideable column', () => {
    expect(EXPLORER_METADATA_COLUMN_IDS).not.toContain('name');
  });

  it('toggles one column without disturbing the others', () => {
    useExplorerColumnVisibilityStore.getState().setColumnVisible('size', true);
    const state = useExplorerColumnVisibilityStore.getState();
    expect(state.size).toBe(true);
    expect(state.tokens).toBe(true);
    expect(state.type).toBe(false);
    useExplorerColumnVisibilityStore.getState().reset();
    expect(useExplorerColumnVisibilityStore.getState().size).toBe(false);
  });

  it('falls back to defaults for malformed or unknown persisted keys', () => {
    expect(sanitizeExplorerColumnVisibility({ nope: true, tokens: 'yes', type: true })).toEqual({
      size: false,
      thread: true,
      tokens: true,
      type: true,
    });
    expect(sanitizeExplorerColumnVisibility(null)).toEqual({
      size: false,
      thread: true,
      tokens: true,
      type: false,
    });
  });
});

describe('explorer sort state store', () => {
  it('defaults to the loader order and persists one global field and direction', () => {
    expect(useExplorerSortStateStore.getState().sortState).toBeNull();
    useExplorerSortStateStore.getState().setSortState({ direction: 'desc', field: 'tokens' });
    expect(useExplorerSortStateStore.getState().sortState).toEqual({
      direction: 'desc',
      field: 'tokens',
    });
    useExplorerSortStateStore.getState().reset();
    expect(useExplorerSortStateStore.getState().sortState).toBeNull();
  });

  it('surfaces malformed persisted state instead of coercing it', () => {
    expect(() =>
      sanitizeExplorerSortState({ sortState: { direction: 'sideways', field: 'tokens' } })
    ).toThrow('Malformed Explorer sort direction: sideways');
    expect(() =>
      sanitizeExplorerSortState({ sortState: { direction: 'asc', field: 'nope' } })
    ).toThrow('Malformed Explorer sort field: nope');
  });
});
