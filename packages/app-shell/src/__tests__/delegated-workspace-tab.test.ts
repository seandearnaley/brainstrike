import { decodeFileSelection } from '@brainstrike/file-explorer/selection';
import {
  __resetWorkspaceTabSelectionStoreForTests,
  useWorkspaceTabSelectionStore,
} from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { afterEach, describe, expect, it } from 'vitest';
import { delegatedWorkspaceTabId, readDelegatedWorkspaceTab } from '../delegated-workspace-tab';

afterEach(__resetWorkspaceTabSelectionStoreForTests);

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
    __resetWorkspaceTabSelectionStoreForTests();
    store.getState().hydrate(saved.openAppIds, saved.selection);
    expect(store.getState().openAppIds.map(readDelegatedWorkspaceTab)).toEqual([first, second]);
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

  it('leaves ordinary apps alone and rejects corrupted child addresses visibly', () => {
    expect(readDelegatedWorkspaceTab('canvas')).toBeUndefined();
    for (const id of [
      'delegated-conversation:%zz',
      'delegated-conversation:%5B%5D',
      'delegated-conversation:%5B%22owner%22%2C%22root%22%2C%22root%22%5D',
    ]) {
      expect(() => readDelegatedWorkspaceTab(id)).toThrow();
    }
  });
});
