/**
 * BST-1990 PR 3: the run's checked files are the curation snapshot, whichever
 * folder the explorer focuses. The host places each file by the thread's
 * binding; the renderer never drops a selection for a focus mismatch.
 */
import { describe, expect, it } from 'vitest';
import { toRuntimeWorkspaceContext } from '../assistant-ui-panel-wrapper-runtime';

const snapshot = {
  files: [
    {
      approxTokens: 5,
      outputApproxTokens: 5,
      path: '/ws/bravo/notes.txt',
      ranges: [],
      rootDisplayName: 'bravo',
      rootId: 'root-b',
    },
  ],
  includeProjectTree: false,
  projectTreeApproxTokens: null,
  projectTreeTokenCountLoading: false,
  selectedOutputApproxTokens: 5,
  selectedSourceApproxTokens: 5,
  selectionFolderId: 'root-b',
  tokenBudget: 100_000,
};

describe('toRuntimeWorkspaceContext', () => {
  it('keeps files checked in a folder other than the focused one', () => {
    expect(toRuntimeWorkspaceContext(snapshot)).toMatchObject({
      files: [{ path: '/ws/bravo/notes.txt', rootId: 'root-b' }],
    });
  });

  it('has nothing to send without a snapshot', () => {
    expect(toRuntimeWorkspaceContext(null)).toBeNull();
  });
});
