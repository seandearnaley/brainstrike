import type { WorkspaceRootRecord } from '@brainstrike/state-store';
import { describe, expect, it, vi } from 'vitest';
import { loadWorkspaceRootsFromCatalog } from '../node-workspace/workspace-roots.ts';

const record = (
  id: string,
  kind: WorkspaceRootRecord['kind'],
  status: WorkspaceRootRecord['status'] = 'live'
): WorkspaceRootRecord => ({
  canonicalPath: `/disposable/${id}`,
  createdAt: 1,
  displayName: id,
  id,
  kind,
  lastVerifiedAt: 1,
  path: `/disposable/${id}`,
  projectId: null,
  projectName: null,
  status,
});

describe('loadWorkspaceRootsFromCatalog', () => {
  it("leaves out a kind from one read: a run with no folder of its own sees no thread's scratch folder (ADR-0034)", async () => {
    const workspaceRoots = vi.fn(async () => ({
      roots: [
        record('project', 'path'),
        record('scratch-a', 'scratch'),
        record('worktree', 'worktree'),
        record('closed', 'path', 'disconnected'),
      ],
    }));

    expect(
      (await loadWorkspaceRootsFromCatalog({ workspaceRoots }, { omitKind: 'scratch' })).map(
        (root) => root.rootId
      )
    ).toEqual(['project', 'worktree']);
    expect(workspaceRoots).toHaveBeenCalledTimes(1);
    expect(
      (await loadWorkspaceRootsFromCatalog({ workspaceRoots })).map((root) => root.rootId)
    ).toEqual(['project', 'scratch-a', 'worktree']);
  });
});
