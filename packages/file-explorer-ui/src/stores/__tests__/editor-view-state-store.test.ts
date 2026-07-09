import { beforeEach, describe, expect, it } from 'vitest';
import { useEditorViewStateStore } from '../editor-view-state-store';

const KEY = 'folder:name:/root/readme.md';

describe('editor-view-state-store modes', () => {
  beforeEach(() => {
    useEditorViewStateStore.getState().clear();
  });

  it('returns undefined for a file with no explicit mode', () => {
    expect(useEditorViewStateStore.getState().getMode(KEY)).toBeUndefined();
  });

  it('persists an explicit mode per key', () => {
    useEditorViewStateStore.getState().setMode(KEY, 'source');
    expect(useEditorViewStateStore.getState().getMode(KEY)).toBe('source');
    expect(useEditorViewStateStore.getState().getMode('other')).toBeUndefined();
  });

  it('clear(key) removes the mode and the preview scroll slot', () => {
    const s = useEditorViewStateStore.getState();
    s.setMode(KEY, 'preview');
    s.setScrollTop(`preview:${KEY}`, 500);
    s.setScrollTop(KEY, 100);
    s.clear(KEY);
    const after = useEditorViewStateStore.getState();
    expect(after.getMode(KEY)).toBeUndefined();
    expect(after.getScrollTop(`preview:${KEY}`)).toBe(0);
    expect(after.getScrollTop(KEY)).toBe(0);
  });

  it('includes modes in the persisted partialization', () => {
    useEditorViewStateStore.getState().setMode(KEY, 'source');
    const persistOptions = useEditorViewStateStore.persist.getOptions();
    const partialized = persistOptions.partialize?.(useEditorViewStateStore.getState());
    expect(partialized).toMatchObject({ modes: { [KEY]: 'source' } });
  });

  it('migrates pre-v2 persisted state by adding an empty modes map', () => {
    const persistOptions = useEditorViewStateStore.persist.getOptions();
    const migrated = persistOptions.migrate?.({ scrollTops: { [KEY]: 42 }, selections: {} }, 1) as {
      modes: Record<string, string>;
      scrollTops: Record<string, number>;
    };
    expect(migrated.modes).toEqual({});
    expect(migrated.scrollTops[KEY]).toBe(42);
  });
});
