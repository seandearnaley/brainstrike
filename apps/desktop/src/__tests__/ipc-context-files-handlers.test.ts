import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceFileReader } from '../assistant-server/workspace-instructions-context';
import { scanWorkspaceContextFilesForReview } from '../ipc-context-files-handlers';

describe('scanWorkspaceContextFilesForReview', () => {
  it('loads the injected roots and scans each for its context file', async () => {
    const loadRoots = vi.fn(async () => [
      { displayName: 'repo-a', path: '/abs/repo-a', rootId: 'root-a' },
    ]);
    const readFile: WorkspaceFileReader = vi.fn(async ({ requestedPath }) => {
      if (requestedPath === 'AGENTS.md') {
        return { content: 'conventions', path: 'AGENTS.md', size: 11 };
      }
      throw new Error('not a file');
    });

    const statuses = await scanWorkspaceContextFilesForReview({ loadRoots, readFile });

    expect(loadRoots).toHaveBeenCalledTimes(1);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      fileName: 'AGENTS.md',
      rootId: 'root-a',
      status: 'fits',
    });
  });

  it('returns an empty list when no roots are mounted', async () => {
    const loadRoots = vi.fn(async () => []);
    const readFile: WorkspaceFileReader = vi.fn();
    const statuses = await scanWorkspaceContextFilesForReview({ loadRoots, readFile });
    expect(statuses).toEqual([]);
    expect(readFile).not.toHaveBeenCalled();
  });
});
