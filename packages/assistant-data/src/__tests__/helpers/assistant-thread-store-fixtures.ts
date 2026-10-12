/**
 * Shared fixtures for the assistant-thread-store suites.
 *
 * Extracted when `assistant-thread-store.test.ts` crossed Biome's 1000-line cap
 * and the watermark cases moved to their own file (BST-1440 merge). Both suites
 * need the same repository double, and duplicating it would let the two copies
 * drift into testing different contracts under the same name.
 */
import { vi } from 'vitest';
import type {
  AssistantMemoryThread,
  AssistantThreadRepository,
} from '../../assistant-memory-repository';

export const workspaceId = '/tmp/workspace-a';

export function makeThread(id: string, updatedAt: string): AssistantMemoryThread {
  return {
    createdAt: new Date('2026-04-22T09:00:00Z'),
    id,
    resourceId: workspaceId,
    title: id,
    updatedAt: new Date(updatedAt),
  };
}

/**
 * A fully-stubbed repository. Every method is a `vi.fn()` so a suite can assert
 * on the calls it cares about; only `listThreads` returns data, because loading
 * is what the store actually does with a repository.
 */
export function createRepository(
  threads: readonly AssistantMemoryThread[] = [
    makeThread('thread-a', '2026-04-22T11:00:00Z'),
    makeThread('thread-b', '2026-04-22T10:00:00Z'),
  ]
): AssistantThreadRepository {
  return {
    appendThreadRunEvent: vi.fn(),
    completeThreadRun: vi.fn(),
    createThread: vi.fn(async (resourceId: string, title = 'New Thread') => ({
      createdAt: new Date('2026-04-22T12:00:00Z'),
      id: 'thread-created',
      resourceId,
      title,
      updatedAt: new Date('2026-04-22T12:00:00Z'),
    })),
    createThreadRun: vi.fn(),
    deleteThread: vi.fn(),
    deleteThreads: vi.fn(),
    getCrossRootUsage: vi.fn(async () => []),
    getThreadCumulativeUsage: vi.fn(async () => null),
    getThreadRunTurnMessageId: vi.fn(async () => null),
    listLatestThreadRuns: vi.fn(async () => []),
    listMessages: vi.fn(async () => []),
    listThreadRunEvents: vi.fn(async () => []),
    listThreads: vi.fn(async () => threads),
    recordRunUsage: vi.fn(),
    renameThread: vi.fn(),
    updateThreadMetadata: vi.fn(),
    updateThreadsMetadata: vi.fn(),
  };
}
