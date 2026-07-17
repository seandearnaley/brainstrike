import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorViewStateStore } from '../stores/editor-view-state-store';

describe('editor-view-state-store', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('coalesces rapid scroll persistence and writes the final value', () => {
    vi.useFakeTimers();
    const setItem = vi.spyOn(localStorage, 'setItem');
    const key = 'root:/foo/rapid-scroll.ts';

    for (let top = 1; top <= 50; top += 1) {
      useEditorViewStateStore.getState().setScrollTop(key, top);
    }

    expect(setItem).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(500);
    expect(setItem.mock.calls.length).toBeLessThanOrEqual(2);
    const persisted = localStorage.getItem('editor-view-state.v1');
    expect(persisted).not.toBeNull();
    expect(JSON.parse(persisted ?? '{}')).toMatchObject({
      state: { scrollTops: { [key]: 50 } },
    });
  });

  it('does not notify subscribers when the clamped scroll value is unchanged', () => {
    const key = 'root:/foo/unchanged-scroll.ts';
    useEditorViewStateStore.getState().setScrollTop(key, 42);
    const subscriber = vi.fn();
    const unsubscribe = useEditorViewStateStore.subscribe(subscriber);

    useEditorViewStateStore.getState().setScrollTop(key, 42.9);

    expect(subscriber).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('sets and gets scroll position per key', () => {
    const key = 'root:/foo/bar.ts';
    const get = useEditorViewStateStore.getState();
    expect(get.getScrollTop(key)).toBe(0);
    get.setScrollTop(key, 123);
    expect(useEditorViewStateStore.getState().getScrollTop(key)).toBe(123);
  });

  it('sets and gets selection per key and clears state', () => {
    const key = 'root:/foo/baz.ts';
    const st = useEditorViewStateStore.getState();
    st.setSelection(key, 5, 10);
    expect(st.getSelection(key)).toEqual({ end: 10, start: 5 });
    st.clear(key);
    expect(useEditorViewStateStore.getState().getSelection(key)).toBeUndefined();
  });

  it('sets, gets, and clears a one-shot view target per key', () => {
    const key = 'root:/foo/target.ts';
    const st = useEditorViewStateStore.getState();
    expect(st.getTarget(key)).toBeUndefined();
    st.setTarget(key, { line: 42 });
    expect(useEditorViewStateStore.getState().getTarget(key)).toEqual({ line: 42 });
    // Coerced to a positive 1-based line.
    st.setTarget(key, { line: 0 });
    expect(useEditorViewStateStore.getState().getTarget(key)).toEqual({ line: 1 });
    st.clear(key);
    expect(useEditorViewStateStore.getState().getTarget(key)).toBeUndefined();
  });

  it('stores a normalized selection range on the view target', () => {
    const key = 'root:/foo/chunk.ts';
    const st = useEditorViewStateStore.getState();
    st.setTarget(key, { line: 8, selection: { endLine: 12, startLine: 8 } });
    expect(useEditorViewStateStore.getState().getTarget(key)).toEqual({
      line: 8,
      selection: { endLine: 12, startLine: 8 },
    });
    // endLine is clamped to at least startLine; lines are coerced to 1-based.
    st.setTarget(key, { line: 5, selection: { endLine: 0, startLine: 5 } });
    expect(useEditorViewStateStore.getState().getTarget(key)).toEqual({
      line: 5,
      selection: { endLine: 5, startLine: 5 },
    });
  });

  it('clearTarget consumes only the view target, leaving scrollTop and selection intact', () => {
    const key = 'root:/foo/consume.ts';
    const st = useEditorViewStateStore.getState();
    st.setScrollTop(key, 30);
    st.setSelection(key, 1, 2);
    st.setTarget(key, { line: 10 });

    st.clearTarget(key);

    const after = useEditorViewStateStore.getState();
    expect(after.getTarget(key)).toBeUndefined();
    expect(after.getScrollTop(key)).toBe(30);
    expect(after.getSelection(key)).toEqual({ end: 2, start: 1 });

    // Idempotent — clearing an already-clear (or never-set) key is a no-op.
    expect(() => after.clearTarget(key)).not.toThrow();
    expect(() => after.clearTarget('root:/foo/never-set.ts')).not.toThrow();
  });

  it('excludes view targets from persistence (one-shot scroll/selection target)', () => {
    const key = 'root:/foo/persist.ts';
    const st = useEditorViewStateStore.getState();
    st.setTarget(key, { line: 7 });
    st.setScrollTop(key, 55);
    // partialize (the persisted shape) keeps scrollTops/selections but not targets.
    const persisted = useEditorViewStateStore.persist
      .getOptions()
      .partialize?.(useEditorViewStateStore.getState());
    expect(persisted).toBeDefined();
    expect(persisted).not.toHaveProperty('targets');
    expect((persisted as { scrollTops: Record<string, number> }).scrollTops[key]).toBe(55);
  });
});

describe('editor-view-state-store modes', () => {
  const KEY = 'folder:name:/root/readme.md';

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
