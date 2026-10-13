/**
 * BST-1990: an Explorer folder header says quietly when the folder is not one
 * of the selected thread's, as the Files cards and the folder chip do.
 */
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useThreadFolderScopeStore } from '../../thread-folder-scope-store';
import { ThreadScopeMarker } from '../thread-scope-marker';

describe('ThreadScopeMarker', () => {
  beforeEach(() => {
    useThreadFolderScopeStore.getState().reset();
  });

  it('marks a folder outside the thread, and clears once the thread adds it', () => {
    useThreadFolderScopeStore.getState().publishScope({ rootIds: ['root-a'], threadId: 't' });
    render(<ThreadScopeMarker rootId="root-b" />);
    expect(screen.getByTestId('thread-scope-marker-root-b')).toHaveTextContent(
      'Not in this thread'
    );

    act(() => {
      useThreadFolderScopeStore
        .getState()
        .publishScope({ rootIds: ['root-a', 'root-b'], threadId: 't' });
    });
    expect(screen.queryByTestId('thread-scope-marker-root-b')).toBeNull();
  });

  it("marks nothing for one of the thread's folders, or while the thread has none", () => {
    useThreadFolderScopeStore.getState().publishScope({ rootIds: ['root-a'], threadId: 't' });
    const { unmount } = render(<ThreadScopeMarker rootId="root-a" />);
    expect(screen.queryByTestId('thread-scope-marker-root-a')).toBeNull();
    unmount();

    useThreadFolderScopeStore.getState().publishScope(null);
    render(<ThreadScopeMarker rootId="root-b" />);
    expect(screen.queryByTestId('thread-scope-marker-root-b')).toBeNull();
  });
});
