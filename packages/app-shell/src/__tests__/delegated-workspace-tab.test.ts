import { decodeFileSelection } from '@brainstrike/file-explorer/selection';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { describe, expect, it } from 'vitest';
import { delegatedWorkspaceTabId } from '../delegated-workspace-tab';

describe('child identity in the existing workspace tabs', () => {
  it('restores two independent children and focuses an already open child only once', () => {
    const first = {
      ownerResourceId: 'workspace:/a b/树',
      rootThreadId: 'root',
      threadId: 'child-a',
    };
    const second = { ...first, threadId: 'child-b' };
    const a = delegatedWorkspaceTabId(first);
    const b = delegatedWorkspaceTabId(second);
    const store = useWorkspaceTabSelectionStore;
    store.getState().hydrate([], { kind: 'empty' });
    store.getState().openApp(a);
    store.getState().openApp(b);
    store.getState().openApp(a);
    expect(store.getState().openAppIds).toEqual([a, b]);
    expect(a).not.toBe(b);
    const saved = structuredClone({
      openAppIds: store.getState().openAppIds,
      selection: store.getState().selection,
    });
    store.getState().hydrate(saved.openAppIds, saved.selection);
    expect(store.getState().openAppIds).toEqual([a, b]);
    expect(store.getState().selection).toEqual({ appId: a, kind: 'app' });
    store.getState().closeApp(a);
    store.getState().openApp(a);
    expect(store.getState().openAppIds).toEqual([b, a]);
  });

  it('never mints an id the workspace strip could mistake for a file tab', () => {
    // The strip's menu dispatches on id: file-tab ids are `folder|@|path`
    // composite keys. Even identities containing the separator stay escaped.
    const id = delegatedWorkspaceTabId({
      ownerResourceId: 'workspace|@|owner',
      rootThreadId: 'root|@|thread',
      threadId: 'child|@|thread',
    });
    expect(() => decodeFileSelection(id)).toThrow();
  });

  it('rejects an invalid child identity visibly instead of minting an address', () => {
    for (const tab of [
      { ownerResourceId: ' ', rootThreadId: 'root', threadId: 'child' },
      { ownerResourceId: 'owner', rootThreadId: 'root', threadId: 'root' },
    ]) {
      expect(() => delegatedWorkspaceTabId(tab)).toThrow();
    }
  });
});
