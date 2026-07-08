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
});
