// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isPartitionRoot } from '../src/index-partition.js';

const optedIn = { worktreeOptIns: new Set(['opted']) };

describe('the roots a saved partition indexes', () => {
  it.each([
    ['a live folder', { id: 'folder', kind: 'path', status: 'live' }, true],
    ['a disconnected folder', { id: 'folder', kind: 'path', status: 'disconnected' }, false],
    ['a worktree opted in', { id: 'opted', kind: 'worktree', status: 'live' }, true],
    ['a worktree not opted in', { id: 'other', kind: 'worktree', status: 'live' }, false],
    [
      'a disconnected worktree opted in',
      { id: 'opted', kind: 'worktree', status: 'disconnected' },
      false,
    ],
  ] as const)('%s: %s', (_case, root, indexed) => {
    expect(isPartitionRoot(root, optedIn)).toBe(indexed);
  });
});
