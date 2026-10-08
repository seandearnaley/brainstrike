import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import type { ThreadSearchRepository } from '@brainstrike/db';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AssistantThreadHostCapability } from '../assistant-thread-host-context';
import { navigateThreadSearchResult } from '../navigate-thread-search-result';
import { resetThreadSearchStore, useThreadSearchStore } from '../thread-search-store';

const OWNER = 'workspace-memory';

function host(owned: readonly string[]): Pick<AssistantThreadHostCapability, 'ownsThread'> {
  return { ownsThread: vi.fn(async (threadId: string) => owned.includes(threadId)) };
}

function repository(): Pick<ThreadSearchRepository, 'getNavigationTarget'> {
  return { getNavigationTarget: vi.fn(async () => null) };
}

let selectThread: ReturnType<typeof vi.fn<(resourceId: string, threadId: string) => void>>;
let openThreadTab: ReturnType<typeof vi.fn<(resourceId: string, threadId: string) => void>>;

beforeEach(() => {
  resetThreadSearchStore();
  selectThread = vi.fn<(resourceId: string, threadId: string) => void>();
  openThreadTab = vi.fn<(resourceId: string, threadId: string) => void>();
  vi.spyOn(useAssistantThreadStore, 'getState').mockReturnValue({
    ...useAssistantThreadStore.getState(),
    openThreadTab,
    selectThread,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('a host-owned hit opens its thread the way the Threads list does, never through history', async () => {
  const history = repository();
  await navigateThreadSearchResult(
    history as ThreadSearchRepository,
    OWNER,
    'host-thread',
    'host-thread:4',
    host(['host-thread'])
  );
  expect(selectThread).toHaveBeenCalledExactlyOnceWith(OWNER, 'host-thread');
  expect(history.getNavigationTarget).not.toHaveBeenCalled();
  expect(useThreadSearchStore.getState().navigationError).toBeNull();
  expect(useThreadSearchStore.getState().navigationTarget).toBeNull();
});

test('a hit the host no longer owns is reported unavailable', async () => {
  const history = repository();
  await navigateThreadSearchResult(
    history as ThreadSearchRepository,
    OWNER,
    'deleted-host-thread',
    'deleted-host-thread:4',
    host([])
  );
  expect(selectThread).not.toHaveBeenCalled();
  expect(useThreadSearchStore.getState().navigationError).toBe(
    'This search result is no longer available in this workspace.'
  );
});
