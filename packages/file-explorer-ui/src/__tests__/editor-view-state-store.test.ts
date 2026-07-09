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

  it('sets, gets, and clears a one-shot target line per key', () => {
    const key = 'root:/foo/target.ts';
    const st = useEditorViewStateStore.getState();
    expect(st.getTargetLine(key)).toBeUndefined();
    st.setTargetLine(key, 42);
    expect(useEditorViewStateStore.getState().getTargetLine(key)).toBe(42);
    // Coerced to a positive 1-based line.
    st.setTargetLine(key, 0);
    expect(useEditorViewStateStore.getState().getTargetLine(key)).toBe(1);
    st.clear(key);
    expect(useEditorViewStateStore.getState().getTargetLine(key)).toBeUndefined();
  });

  it('clearTargetLine consumes only the target line, leaving scrollTop and selection intact', () => {
    const key = 'root:/foo/consume.ts';
    const st = useEditorViewStateStore.getState();
    st.setScrollTop(key, 30);
    st.setSelection(key, 1, 2);
    st.setTargetLine(key, 10);

    st.clearTargetLine(key);

    const after = useEditorViewStateStore.getState();
    expect(after.getTargetLine(key)).toBeUndefined();
    expect(after.getScrollTop(key)).toBe(30);
    expect(after.getSelection(key)).toEqual({ end: 2, start: 1 });

    // Idempotent — clearing an already-clear (or never-set) key is a no-op.
    expect(() => after.clearTargetLine(key)).not.toThrow();
    expect(() => after.clearTargetLine('root:/foo/never-set.ts')).not.toThrow();
  });

  it('excludes target lines from persistence (one-shot scroll target)', () => {
    const key = 'root:/foo/persist.ts';
    const st = useEditorViewStateStore.getState();
    st.setTargetLine(key, 7);
    st.setScrollTop(key, 55);
    // partialize (the persisted shape) keeps scrollTops/selections but not targetLines.
    const persisted = useEditorViewStateStore.persist
      .getOptions()
      .partialize?.(useEditorViewStateStore.getState());
    expect(persisted).toBeDefined();
    expect(persisted).not.toHaveProperty('targetLines');
    expect((persisted as { scrollTops: Record<string, number> }).scrollTops[key]).toBe(55);
  });
});
