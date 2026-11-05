// @vitest-environment node
import type { HostClient } from '@brainstrike/agent-host/browser';
import { expect, test, vi } from 'vitest';
import { hostApprovalChange } from '../renderer/host-approval-change';

const change = { after: 'b\n', before: 'a\n', path: 'notes.md' };

/** The viewed thread waits on `own`; its delegated child waits on `child-interaction`. */
function reader() {
  const request = vi.fn(async () => change);
  const conversation = {
    approvals: {
      getSnapshot: () => [
        {
          approval: { interactionId: 'child-interaction', runId: 'child-run' },
          owner: 'Explorer 1',
          threadId: 'child',
        },
      ],
    },
    store: {
      getCommittedView: () => ({
        pendingInteractions: [{ interactionId: 'own', runId: 'root-run', threadId: 'root' }],
      }),
    },
  };
  return {
    read: hostApprovalChange({ request } as unknown as HostClient, conversation as never),
    request,
  };
}

test("the viewed thread's approval is read in its own run", async () => {
  const { read, request } = reader();
  await expect(read('own')).resolves.toEqual(change);
  expect(request).toHaveBeenCalledWith('interaction/preview', {
    interactionId: 'own',
    runId: 'root-run',
    threadId: 'root',
  });
});

test("a delegated child's approval is read in the child's thread", async () => {
  const { read, request } = reader();
  await read('child-interaction');
  expect(request).toHaveBeenCalledWith('interaction/preview', {
    interactionId: 'child-interaction',
    runId: 'child-run',
    threadId: 'child',
  });
});

test('an approval that no longer waits is refused in plain words', async () => {
  const { read, request } = reader();
  await expect(read('answered')).rejects.toThrow('This approval is no longer waiting.');
  expect(request).not.toHaveBeenCalled();
});
