/**
 * BFS engine performance-budget branch tests.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerFileNode, WorkerToMainMessage } from './types';

const perfTiming = vi.hoisted(() => ({
  checkBudget: vi.fn<[string, number, string], boolean>(),
  durationMs: 0,
}));

vi.mock('@brainstrike/utils/perf-timing', () => ({
  checkBudget: perfTiming.checkBudget,
  createTimer: vi.fn(() => ({
    elapsed: () => perfTiming.durationMs,
  })),
}));

const { BFSEngine } = await import('./bfs-engine');

function createDirectoryNode(overrides: Partial<WorkerFileNode> = {}): WorkerFileNode {
  return {
    depth: 1,
    loadState: 'unloaded',
    name: 'dir',
    path: '/root/dir',
    rootFolderId: 'root',
    type: 'directory',
    ...overrides,
  };
}

describe('BFSEngine performance budget reporting', () => {
  let engine: InstanceType<typeof BFSEngine>;
  let messages: WorkerToMainMessage[];

  beforeEach(() => {
    messages = [];
    perfTiming.durationMs = 0;
    perfTiming.checkBudget.mockReset();
    perfTiming.checkBudget.mockReturnValue(false);
    engine = new BFSEngine((message: WorkerToMainMessage) => {
      messages.push(message);
    });
  });

  it('logs slow expand-all batches when the expand budget is exceeded', async () => {
    perfTiming.durationMs = 75;
    perfTiming.checkBudget.mockImplementation((name) => name.startsWith('batch-load-'));
    engine.setTree([createDirectoryNode()], 'root');

    const expandPromise = engine.expandAll(91);

    await vi.waitFor(() => {
      expect(messages.some((message) => message.type === 'requestLoad')).toBe(true);
    });
    const request = messages.find((message) => message.type === 'requestLoad');
    if (request?.type !== 'requestLoad') {
      throw new Error('expected requestLoad message');
    }

    engine.handleLoadResult('/root/dir', [], request.payload.requestId);

    await expandPromise;

    expect(perfTiming.checkBudget).toHaveBeenCalledWith('batch-load-1', 75, 'expandBatch');
    expect(messages).toContainEqual({
      level: 'debug',
      message: '[expand-all] Slow batch: 1 dirs in 75ms',
      type: 'log',
    });
    expect(messages).toContainEqual({
      level: 'info',
      message: '[expand-all] 1 batch(es) exceeded performance budget',
      type: 'log',
    });
  });
});
