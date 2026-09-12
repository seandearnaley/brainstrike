// @vitest-environment jsdom

import type { DelegatedConversationUpdate } from '@brainstrike/assistant-ui';
import type { DelegatedConversationInsights } from '@brainstrike/db';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useDelegatedConversationInsights } from '../use-delegated-conversation-insights';
import { delegatedUpdate } from './helpers/delegated-conversation-fixtures';

const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@brainstrike/db', async (load) => ({
  ...(await load<typeof import('@brainstrike/db')>()),
  readDelegatedConversationInsights: read,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const db = { query: vi.fn(async () => ({ rows: [] })) };
const node = (threadId: string) => ({ ownerResourceId: 'owner', rootThreadId: 'root', threadId });
const value = (threadId: string): DelegatedConversationInsights => ({
  configuration: {},
  depth: 1,
  directUsage: null,
  latestExecutionConfiguration: null,
  latestRun: null,
  subtreeUsage: null,
  threadId,
});

it('refreshes exact child details after a terminal update without querying every text delta', async () => {
  read.mockImplementation(async (_db, _scope, threadId: string) => value(threadId));
  const running = delegatedUpdate('child');
  const hook = renderHook(
    ({ update }) => useDelegatedConversationInsights({ db, node: node('child'), update }),
    { initialProps: { update: running as DelegatedConversationUpdate } }
  );
  await waitFor(() =>
    expect(hook.result.current).toEqual({ status: 'ready', value: value('child') })
  );
  expect(read).toHaveBeenCalledWith(
    db,
    { ownerResourceId: 'owner', rootThreadId: 'root' },
    'child'
  );
  hook.rerender({ update: delegatedUpdate('child', 'initial', 'new text') });
  expect(read).toHaveBeenCalledTimes(1);
  hook.rerender({
    update: {
      ...running,
      message: { ...running.message, status: { reason: 'stop', type: 'complete' } },
    },
  });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
});
it('hides the previous child immediately and refuses its late response after selection changes', async () => {
  const pending = Promise.withResolvers<DelegatedConversationInsights>();
  read.mockReturnValueOnce(pending.promise).mockResolvedValue(value('sibling'));
  const hook = renderHook(({ id }) => useDelegatedConversationInsights({ db, node: node(id) }), {
    initialProps: { id: 'child' },
  });
  expect(hook.result.current.status).toBe('loading');
  hook.rerender({ id: 'sibling' });
  expect(hook.result.current.status).toBe('loading');
  await waitFor(() =>
    expect(hook.result.current).toEqual({ status: 'ready', value: value('sibling') })
  );
  await act(async () => {
    pending.resolve(value('child'));
    await pending.promise;
  });
  expect(hook.result.current).toEqual({ status: 'ready', value: value('sibling') });
});
it('surfaces authorized read failure instead of retaining another owner or showing zero usage', async () => {
  const error = new Error('Child owner is unavailable.');
  read.mockRejectedValue(error);
  const hook = renderHook(() => useDelegatedConversationInsights({ db, node: node('child') }));
  await waitFor(() => expect(hook.result.current).toEqual({ error, status: 'error' }));
});
