import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceFileReader } from '../assistant-server/workspace-instructions-context';
import { scanWorkspaceContextFilesForReview } from '../ipc-context-files-handlers';

describe('scanWorkspaceContextFilesForReview', () => {
  it('loads the injected roots and scans each for its context file', async () => {
    const workspaceRoots = {
      workspaceRoots: vi.fn(async () => ({
        roots: [
          {
            createdAt: 1,
            displayName: 'repo-a',
            id: 'root-a',
            kind: 'path' as const,
            lastVerifiedAt: 1,
            path: '/abs/repo-a',
            status: 'live' as const,
          },
        ],
      })),
    };
    const readFile: WorkspaceFileReader = vi.fn(async ({ requestedPath }) => {
      if (requestedPath === 'AGENTS.md') {
        return { content: 'conventions', path: 'AGENTS.md', size: 11 };
      }
      throw new Error('not a file');
    });

    const statuses = await scanWorkspaceContextFilesForReview({ readFile, workspaceRoots });

    expect(workspaceRoots.workspaceRoots).toHaveBeenCalledWith({ operation: 'list' });
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      fileName: 'AGENTS.md',
      rootId: 'root-a',
      status: 'fits',
    });
  });

  it('returns an empty list when no roots are mounted', async () => {
    const workspaceRoots = { workspaceRoots: vi.fn(async () => ({ roots: [] })) };
    const readFile: WorkspaceFileReader = vi.fn();
    const statuses = await scanWorkspaceContextFilesForReview({ readFile, workspaceRoots });
    expect(statuses).toEqual([]);
    expect(readFile).not.toHaveBeenCalled();
  });
});
