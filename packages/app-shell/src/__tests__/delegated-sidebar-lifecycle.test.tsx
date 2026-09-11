import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DelegatedConversationRootsProvider } from '../delegated-conversation-root';
import type { ChildNode } from '../delegated-workspace-node';
import type { ThreadPanelVisibleRow } from '../thread-panel-visible-rows';
import { useDelegatedConversationRoot } from '../use-delegated-conversation-root';
import { useDelegatedSidebar } from '../use-delegated-sidebar';
import { delegatedUpdate } from './helpers/delegated-conversation-fixtures';

const mocks = vi.hoisted(() => ({ db: { query: vi.fn() }, listChildren: vi.fn() }));
vi.mock('@brainstrike/db/react', () => ({ usePGliteDatabase: () => mocks.db }));
vi.mock('@brainstrike/db', async (original) => ({
  ...(await original<typeof import('@brainstrike/db')>()),
  createDelegatedConversationRepository: () => ({ listChildren: mocks.listChildren }),
}));
const child: ChildNode = {
  color: 'emerald',
  configuration: {},
  createdAt: new Date(),
  displayName: 'Cedar',
  ownerResourceId: WORKSPACE_MEMORY_RESOURCE_ID,
  parentThreadId: 'root',
  resourceId: 'native-child',
  rootThreadId: 'root',
  threadId: 'cedar',
  workspaceRootId: null,
};
const row: ThreadPanelVisibleRow = {
  groupId: null,
  id: 'root',
  kind: 'thread',
  parentId: null,
  thread: {
    createdAt: new Date(),
    id: 'root',
    resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    title: 'Main',
    updatedAt: new Date(),
  },
};
const base = [row];
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('revalidates reopened children and releases hidden descendant subscriptions', async () => {
  mocks.listChildren.mockImplementation(async (_scope, parentId) =>
    parentId === 'root' ? [child] : []
  );
  const { result } = renderHook(
    () => ({
      root: useDelegatedConversationRoot(WORKSPACE_MEMORY_RESOURCE_ID, 'root'),
      sidebar: useDelegatedSidebar(base),
    }),
    { wrapper: DelegatedConversationRootsProvider }
  );
  act(() => result.current.sidebar.toggle(row));
  await waitFor(() => expect(result.current.sidebar.rows[1]?.kind).toBe('delegated'));
  const cedar = result.current.sidebar.rows[1];
  if (!cedar) {
    throw new Error('Expected child sidebar row');
  }
  act(() => result.current.sidebar.toggle(cedar));
  await waitFor(() => expect(mocks.listChildren).toHaveBeenCalledTimes(2));
  act(() => result.current.sidebar.toggle(row));
  const before = mocks.listChildren.mock.calls.length;
  act(() => result.current.root?.onDelegatedConversation(delegatedUpdate('new-child')));
  expect(mocks.listChildren).toHaveBeenCalledTimes(before);
  mocks.listChildren.mockResolvedValue([]);
  act(() => result.current.sidebar.toggle(row));
  await waitFor(() =>
    expect(result.current.sidebar.rows[1]).toMatchObject({ label: 'No child conversations' })
  );
  expect(result.current.sidebar.rows).toHaveLength(2);
});
