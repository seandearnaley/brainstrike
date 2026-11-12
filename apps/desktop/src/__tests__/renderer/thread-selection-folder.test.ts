import { describe, expect, it } from 'vitest';
import { threadSelectionFolderId } from '../../renderer/thread-selection-folder';

// ADR-0034: a run names the Explorer's focus only when its thread can see that folder. The
// Explorer keeps its last focus while the active thread shows no folder, so the focus can be
// another thread's scratch folder or worktree.
const explorer = (currentFolderId: string | null, activeRootIds: string[] = []) => ({
  activeRootIds,
  currentFolderId,
});

describe('threadSelectionFolderId', () => {
  it('names an open folder, whatever the thread works in', () => {
    expect(threadSelectionFolderId(explorer('project', ['project']), null)).toBe('project');
  });

  it("names the thread's own scratch folder or worktree, and the folder its worktree left", () => {
    expect(threadSelectionFolderId(explorer('scratch-a'), { operatingRootId: 'scratch-a' })).toBe(
      'scratch-a'
    );
    const inWorktree = { checkoutLocalRootId: 'repo', operatingRootId: 'worktree' };
    expect(threadSelectionFolderId(explorer('worktree'), inWorktree)).toBe('worktree');
    expect(threadSelectionFolderId(explorer('repo'), inWorktree)).toBe('repo');
    expect(
      threadSelectionFolderId(explorer('notes'), {
        operatingRootId: 'scratch-a',
        secondaryRootIds: ['notes'],
      })
    ).toBe('notes');
  });

  it("names nothing for another thread's folder, or for a thread with no folder", () => {
    expect(threadSelectionFolderId(explorer('scratch-a'), null)).toBeNull();
    expect(
      threadSelectionFolderId(explorer('scratch-a', ['project']), { operatingRootId: 'scratch-b' })
    ).toBeNull();
    expect(threadSelectionFolderId(explorer(null, ['project']), null)).toBeNull();
  });
});
