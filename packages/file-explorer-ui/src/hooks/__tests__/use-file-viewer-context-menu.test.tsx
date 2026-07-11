import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useFileViewerContextMenu } from '../use-file-viewer-context-menu';

describe('useFileViewerContextMenu', () => {
  const rootId = '6d15f31b-cc44-46f7-8eb1-01a1f7b086d8';
  const compositeKey = encodeFileSelection(rootId, '/Users/dev/project/src/index.ts');
  const tab = {
    compositeKey,
    id: compositeKey,
    path: '/Users/dev/project/src/index.ts',
  };

  it('claims the exact source selection snapshot for the current viewer', () => {
    const { result } = renderHook(() =>
      useFileViewerContextMenu({
        rootPath: '/Users/dev/project',
        tab,
        viewMode: 'source',
      })
    );

    act(() => {
      result.current.handleCodeContextMenuSelection({ from: 4, text: '\n  ', to: 7 });
    });

    expect(result.current.controller.target).toMatchObject({
      kind: 'file-viewer',
      selectionText: '\n  ',
      sourceRange: { from: 4, to: 7 },
      viewMode: 'source',
    });
  });

  it('clears a stale selection before claiming file-level viewer actions', () => {
    const { result } = renderHook(() =>
      useFileViewerContextMenu({
        rootPath: '/Users/dev/project',
        tab,
        viewMode: 'preview',
      })
    );

    act(() => {
      result.current.handleMarkdownContextMenuSelection({ text: 'selected' });
    });
    expect(result.current.controller.target).toMatchObject({ selectionText: 'selected' });

    act(() => {
      result.current.resetContextMenuTarget();
      result.current.handleViewerContextMenu();
    });

    expect(result.current.controller.target).toMatchObject({
      kind: 'file-viewer',
      selectionText: null,
      sourceRange: null,
      viewMode: 'preview',
    });
  });
});
