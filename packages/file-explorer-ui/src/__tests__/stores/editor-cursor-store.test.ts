import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetEditorCursorStoreForTests,
  type CursorSelection,
  useEditorCursorStore,
} from '../../stores/editor-cursor-store';

describe('editor-cursor-store', () => {
  beforeEach(() => {
    __resetEditorCursorStoreForTests();
  });

  it('sets and gets selection per composite key', () => {
    const key = 'root:/a.ts';
    const sel: CursorSelection = { cursor: 10, selectionEnd: 12, selectionStart: 5 };
    useEditorCursorStore.getState().setSelection(key, sel);
    expect(useEditorCursorStore.getState().getSelection(key)).toEqual(sel);
  });

  it('clears selection for a given key', () => {
    const key = 'root:/b.ts';
    useEditorCursorStore.getState().setSelection(key, {
      cursor: 1,
      selectionEnd: 1,
      selectionStart: 1,
    });
    useEditorCursorStore.getState().clear(key);
    expect(useEditorCursorStore.getState().getSelection(key)).toBeUndefined();
  });
});
