import { describe, expect, it } from 'vitest';
import { useEditorViewStateStore } from '../stores/editor-view-state-store';

describe('editor-view-state-store', () => {
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
