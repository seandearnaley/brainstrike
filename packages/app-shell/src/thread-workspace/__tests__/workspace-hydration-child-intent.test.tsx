import {
  EMPTY_WORKSPACE_SNAPSHOT,
  type ThreadWorkspaceRepository,
  type WorkspaceSnapshotV1,
} from '@brainstrike/assistant-data';
import { act } from '@brainstrike/test-utils/react-act';
import { renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { hostChildWorkspaceTabId } from '../../host-child-workspace-tab';
import { useThreadWorkspaceCoordinator } from '../use-thread-workspace-coordinator';
import type { WorkspaceStateFacade } from '../workspace-snapshot-io';

const child = (threadId: string) => hostChildWorkspaceTabId({ persona: 'worker', threadId });

function fixture() {
  const state = {
    openAppIds: ['context-explorer'] as readonly string[],
    selection: {
      appId: 'context-explorer',
      kind: 'app',
    } as WorkspaceSnapshotV1['apps']['selection'],
  };
  const listeners = new Set<() => void>();
  const rows = new Map<string, WorkspaceSnapshotV1>();
  const pending = Promise.withResolvers<WorkspaceSnapshotV1 | null>();
  const facade: WorkspaceStateFacade = {
    applyApps: (openAppIds, selection) => Object.assign(state, { openAppIds, selection }),
    applyEditorState: vi.fn(),
    applyExpandedPaths: vi.fn(),
    applyExplorerScrollTop: vi.fn(),
    applyFileTabs: vi.fn(),
    applyPanes: vi.fn(),
    applyRootViews: vi.fn(),
    closeApps: (ids) => {
      state.openAppIds = state.openAppIds.filter((id) => !ids.includes(id));
      if (state.selection.kind === 'app' && ids.includes(state.selection.appId)) {
        state.selection = { appId: 'context-explorer', kind: 'app' };
      }
    },
    getEditorState: () => ({}),
    getExpandedDirectoryPaths: () => new Set(),
    getExplorerScrollTop: () => undefined,
    getFileTabs: () => EMPTY_WORKSPACE_SNAPSHOT.fileTabs,
    getFocusedRootId: () => null,
    getOpenAppIds: () => state.openAppIds,
    getRootDescriptors: () => ({}),
    getSelection: () => state.selection,
    getVisibleRootIds: () => null,
  };
  const repository: ThreadWorkspaceRepository = {
    getThreadWorkspace: vi.fn(async (id) =>
      id === 'old-root' ? (rows.get(id) ?? null) : pending.promise
    ),
    getThreadWorkspaces: async () => new Map(),
    setThreadWorkspace: vi.fn(async (id, _resourceId, snapshot) => {
      rows.set(id, snapshot);
    }),
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const open = (id: string) => {
    state.openAppIds = [...state.openAppIds, id];
    state.selection = { appId: id, kind: 'app' };
    for (const listener of listeners) {
      listener();
    }
  };
  const render = (
    active = 'new-root',
    initialRepository: ThreadWorkspaceRepository | null = repository
  ) =>
    renderHook(
      ({ activeThreadId, repository: currentRepository }) =>
        useThreadWorkspaceCoordinator({
          activeThreadId,
          facade,
          openThreadIds: ['old-root', 'new-root'],
          repository: currentRepository,
          resourceId: 'workspace',
          subscribe,
        }),
      { initialProps: { activeThreadId: active, repository: initialRepository } }
    );
  return { open, pending, render, repository, rows, state };
}

it.each([false, true])(
  'retains a child opened while a new root is loading, including deferred repository startup (%s)',
  async (deferredRepository) => {
    const f = fixture();
    const view = f.render('new-root', deferredRepository ? null : f.repository);
    const incoming = child('incoming-child');
    act(() => f.open(incoming));
    if (deferredRepository) {
      view.rerender({ activeThreadId: 'new-root', repository: f.repository });
    }
    await act(async () => {
      f.pending.resolve(null);
    });
    await waitFor(() => expect(f.rows.has('new-root')).toBe(true));
    expect(f.state.openAppIds).toEqual(['context-explorer', incoming]);
    expect(f.rows.get('new-root')?.apps).toEqual({
      openAppIds: ['context-explorer', incoming],
      selection: { appId: incoming, kind: 'app' },
    });
  }
);

it('retires inherited outgoing children while retaining a new child opened during the incoming read', async () => {
  const f = fixture();
  const outgoing = child('outgoing-child');
  const incoming = child('incoming-child');
  f.rows.set('old-root', {
    ...EMPTY_WORKSPACE_SNAPSHOT,
    apps: {
      openAppIds: ['context-explorer', outgoing],
      selection: { appId: outgoing, kind: 'app' },
    },
  });
  const view = f.render('old-root');
  await waitFor(() => expect(f.state.openAppIds).toContain(outgoing));
  view.rerender({ activeThreadId: 'new-root', repository: f.repository });
  act(() => f.open(incoming));
  await act(async () => {
    f.pending.resolve(null);
  });
  await waitFor(() => expect(f.rows.has('new-root')).toBe(true));
  expect(f.rows.get('old-root')?.apps.openAppIds).toEqual(['context-explorer', outgoing]);
  expect(f.state.openAppIds).toEqual(['context-explorer', incoming]);
  expect(f.rows.get('new-root')?.apps).toEqual({
    openAppIds: ['context-explorer', incoming],
    selection: { appId: incoming, kind: 'app' },
  });
});
