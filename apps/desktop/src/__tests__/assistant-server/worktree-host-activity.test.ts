import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import { expect, test, vi } from 'vitest';
import { hasHostRunInWorktree } from '../../assistant-server/worktree-host-activity';

const binding = {
  checkoutLocalRootId: 'root-alpha',
  checkoutMode: 'worktree' as const,
  checkoutWorktreeId: 'worktree-alpha',
  checkoutWorktreePath: '/disposable/alpha',
};

const rows: readonly HostLogRow[] = [
  {
    event: {
      modelId: 'test-model',
      prompt: 'work',
      runId: 'run-active',
      snapshot: { configuration: {}, maxSteps: 1, toolIdentities: {}, workspaceBinding: binding },
      type: 'run.started',
    },
    seq: 1,
    threadId: 'child-other',
  },
];

test('archive protects a child or another thread running in the worktree, independent of creator identity', async () => {
  const readThread = vi.fn(async () => rows);
  await expect(
    hasHostRunInWorktree(
      {
        readLedger: async () => ({
          threads: [
            { runs: [{ runId: 'run-old', status: 'completed' }], threadId: 'creator' },
            { runs: [{ runId: 'run-active', status: 'running' }], threadId: 'child-other' },
          ],
        }),
        readThread,
      },
      'worktree-alpha'
    )
  ).resolves.toBe(true);
  expect(readThread).toHaveBeenCalledExactlyOnceWith('child-other');
});

test('archive remains blocked during cancellation until the host records terminal settlement', async () => {
  let status = 'running';
  const authority = {
    readLedger: async () => ({
      threads: [{ runs: [{ runId: 'run-active', status }], threadId: 'thread-alpha' }],
    }),
    readThread: async () => rows,
  };
  await expect(hasHostRunInWorktree(authority, 'worktree-alpha')).resolves.toBe(true);
  status = 'cancelled';
  await expect(hasHostRunInWorktree(authority, 'worktree-alpha')).resolves.toBe(false);
});

test('unavailable run or binding authority rejects rather than authorizing archive', async () => {
  const lost = new Error('host disconnected');
  await expect(
    hasHostRunInWorktree(
      {
        readLedger: async () => {
          throw lost;
        },
        readThread: async () => rows,
      },
      'worktree-alpha'
    )
  ).rejects.toBe(lost);
  await expect(
    hasHostRunInWorktree(
      {
        readLedger: async () => ({
          threads: [
            { runs: [{ runId: 'run-active', status: 'running' }], threadId: 'thread-alpha' },
          ],
        }),
        readThread: async () => {
          throw lost;
        },
      },
      'worktree-alpha'
    )
  ).rejects.toBe(lost);
});

test('an unrelated or unbound active thread does not claim the worktree', async () => {
  await expect(
    hasHostRunInWorktree(
      {
        readLedger: async () => ({
          threads: [{ runs: [{ runId: 'run-active', status: 'running' }], threadId: 'unbound' }],
        }),
        readThread: async () => [
          {
            event: {
              modelId: 'test-model',
              prompt: 'unbound',
              runId: 'run-active',
              type: 'run.started',
            },
            seq: 1,
            threadId: 'unbound',
          },
        ],
      },
      'worktree-alpha'
    )
  ).resolves.toBe(false);
});

test('missing committed start receipt refuses archive instead of assuming an unbound run', async () => {
  await expect(
    hasHostRunInWorktree(
      {
        readLedger: async () => ({
          threads: [
            { runs: [{ runId: 'run-active', status: 'running' }], threadId: 'thread-alpha' },
          ],
        }),
        readThread: async () => [],
      },
      'worktree-alpha'
    )
  ).rejects.toThrow();
});
