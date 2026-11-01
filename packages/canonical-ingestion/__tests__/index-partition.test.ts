// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isPartitionRoot } from '../src/index-partition.js';

describe('the roots a saved partition indexes', () => {
  it.each([
    ['a live folder', { kind: 'path', status: 'live' }, true],
    ['a disconnected folder', { kind: 'path', status: 'disconnected' }, false],
    // A worktree reads its repository's index through another checkout (ADR-0034).
    ['a live worktree', { kind: 'worktree', status: 'live' }, false],
  ] as const)('%s: %s', (_case, root, indexed) => {
    expect(isPartitionRoot(root)).toBe(indexed);
  });
});
