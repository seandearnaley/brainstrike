/**
 * `RewindConflictList` copy accuracy (BST-1115 review finding).
 *
 * `force`/the acknowledgment checkbox only overrides `disk-changed` and
 * `path-occupied` — `revertCheckpointEntry` throws `CheckpointNotRevertibleError`
 * for `root-unavailable`/`capture-unavailable` BEFORE `force` is ever consulted
 * (`edit-checkpoint-revert.ts`'s `resolveRootPathForRow` and the capture-status
 * guard). The checkbox copy must say which is true for the conflict set it is
 * currently gating, on the one control that authorizes the destructive path.
 */
import type { AssistantRewindConflict } from '@brainstrike/assistant-contract';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RewindConflictModel } from '../rewind-port';
import { RewindConflictList } from '../ui/rewind-conflict-list';

/** A legacy conflict as its port maps it: forceable only for the codes force overrides. */
function conflict(
  code: AssistantRewindConflict['code'],
  path = 'src/index.ts'
): RewindConflictModel {
  return {
    forceable: code === 'disk-changed' || code === 'path-occupied',
    message: 'test conflict',
    path,
    rootId: 'root-a',
    rootLabel: 'Repo A',
  };
}

describe('RewindConflictList — acknowledgment copy', () => {
  it('says files will be overwritten when every conflict is forceable', () => {
    render(
      <RewindConflictList
        acknowledged={false}
        conflicts={[conflict('disk-changed'), conflict('path-occupied', 'b.txt')]}
        onAcknowledgedChange={vi.fn()}
      />
    );
    expect(screen.getByText(/these files will be overwritten/i)).toBeInTheDocument();
    expect(screen.queryByText(/left as they are/i)).not.toBeInTheDocument();
  });

  it('does not claim an overwrite for conflicts force cannot touch', () => {
    render(
      <RewindConflictList
        acknowledged={false}
        conflicts={[conflict('root-unavailable')]}
        onAcknowledgedChange={vi.fn()}
      />
    );
    expect(screen.queryByText(/these files will be overwritten/i)).not.toBeInTheDocument();
    expect(screen.getByText(/left as they are/i)).toBeInTheDocument();
  });

  it('uses the mixed copy when only SOME conflicts in the set are forceable', () => {
    render(
      <RewindConflictList
        acknowledged={false}
        conflicts={[conflict('disk-changed'), conflict('capture-unavailable', 'c.txt')]}
        onAcknowledgedChange={vi.fn()}
      />
    );
    expect(screen.queryByText(/these files will be overwritten/i)).not.toBeInTheDocument();
    expect(screen.getByText(/left as they are/i)).toBeInTheDocument();
  });
});
