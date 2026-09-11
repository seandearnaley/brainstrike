import { DelegatedConversationIdentityError } from '@brainstrike/db';
import { beforeEach, expect, it, vi } from 'vitest';
import { handleDelegatedCancelRequest } from '../../assistant-server/cancel-delegated-conversation';
import { createRunRequest } from './_harness';

const { revoke, logError } = vi.hoisted(() => ({ logError: vi.fn(), revoke: vi.fn() }));
vi.mock('../../assistant-server/logger', () => ({
  desktopAssistantServerLogger: { error: logError },
}));
vi.mock('../../db-main', () => ({ getDatabase: async () => ({}) }));
vi.mock('../../assistant-server/delegated-cancellation-admission', () => ({
  revokeDelegatedConversationAdmission: revoke,
}));
vi.mock('../../assistant-server/mastra-memory', () => ({ getDesktopMastraMemory: vi.fn() }));
const request = createRunRequest(handleDelegatedCancelRequest);
beforeEach(() => {
  revoke.mockReset();
  logError.mockClear();
});

it.each(['cancellation-child-scope-invalid', 'cancellation-invocation-unavailable'])(
  'returns unavailable identity rather than retryable cleanup for %s',
  async (reason) => {
    revoke.mockRejectedValue(new DelegatedConversationIdentityError(reason));
    const response = await request({
      body: JSON.stringify({
        ownerResourceId: 'owner',
        rootThreadId: 'root',
        scope: 'subtree',
        threadId: 'child',
      }),
      method: 'POST',
      url: '/assistant/cancel-child',
    });
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toMatchObject({ error: 'child_cancel_unavailable' });
  }
);

it('keeps a real storage or cleanup failure visibly incomplete', async () => {
  revoke.mockRejectedValue(new Error('Storage unavailable'));
  const response = await request({
    body: JSON.stringify({
      ownerResourceId: 'owner',
      rootThreadId: 'root',
      scope: 'subtree',
      threadId: 'child',
    }),
    method: 'POST',
    url: '/assistant/cancel-child',
  });
  expect(response.status).toBe(503);
  expect(JSON.parse(response.body)).toMatchObject({ error: 'child_cancel_incomplete' });
  expect(logError).toHaveBeenCalled();
});
