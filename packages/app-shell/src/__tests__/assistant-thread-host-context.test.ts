import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { expect, test, vi } from 'vitest';
import {
  type AssistantThreadHostCapability,
  createHostAssistantThreadRepository,
} from '../assistant-thread-host-context';
import { hostChildWorkspaceTabId } from '../host-child-workspace-tab';

const OWNED = new Set(['owned-thread', 'owned-first', 'owned-second']);

function hostFixture(deleteOwned: AssistantThreadHostCapability['deleteThread']) {
  const host: AssistantThreadHostCapability = {
    createThread: vi.fn(),
    deleteThread: deleteOwned,
    listThreads: vi.fn(),
    ownsThread: vi.fn(async (threadId: string) => OWNED.has(threadId)),
    renameThread: vi.fn(async () => undefined),
    renderThread: vi.fn(),
    updateThreadBinding: vi.fn(async () => undefined),
    workspaceRepository: () => {
      throw new Error('Unexpected workspace snapshot access in this fixture');
    },
  };
  return { host };
}

const childTab = (threadId: string) => hostChildWorkspaceTabId({ persona: 'worker', threadId });

test('the host-only catalog refuses unowned mutations', async () => {
  const { host } = hostFixture(vi.fn(async () => undefined));
  const catalog = createHostAssistantThreadRepository(host);
  await expect(catalog.renameThread('unowned', 'Title')).rejects.toBeInstanceOf(Error);
  await expect(catalog.updateThreadMetadata('unowned', { color: 'rose' })).rejects.toBeInstanceOf(
    Error
  );
  await expect(catalog.deleteThread('unowned')).rejects.toBeInstanceOf(Error);
  expect(host.renameThread).not.toHaveBeenCalled();
  expect(host.updateThreadBinding).not.toHaveBeenCalled();
  await expect(catalog.deleteThreads?.(['unowned'])).rejects.toBeInstanceOf(Error);
  expect(catalog.updateThreadsMetadata).toBeUndefined();
});

test('host-only mutations preserve the original owner failure', async () => {
  const failure = new Error('Owned write failed');
  const { host } = hostFixture(
    vi.fn(async () => {
      throw failure;
    })
  );
  vi.mocked(host.renameThread).mockRejectedValueOnce(failure);
  vi.mocked(host.updateThreadBinding).mockRejectedValueOnce(failure);
  const catalog = createHostAssistantThreadRepository(host);
  await expect(catalog.renameThread('owned-thread', 'Title')).rejects.toBe(failure);
  await expect(catalog.updateThreadMetadata('owned-thread', { color: 'rose' })).rejects.toBe(
    failure
  );
  await expect(catalog.deleteThread('owned-thread')).rejects.toBe(failure);
});

test('host-only deletion keeps child tabs until the owner joins the physical deletion', async () => {
  const entered = Promise.withResolvers<void>();
  const joined = Promise.withResolvers<readonly string[]>();
  const { host } = hostFixture(async () => {
    entered.resolve();
    return joined.promise;
  });
  useWorkspaceTabSelectionStore
    .getState()
    .hydrate([childTab('child'), childTab('kept')], { appId: childTab('child'), kind: 'app' });
  const deletion = createHostAssistantThreadRepository(host).deleteThread('owned-thread');
  await entered.promise;
  expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual([
    childTab('child'),
    childTab('kept'),
  ]);
  joined.resolve(['child', 'owned-thread']);
  await deletion;
  expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual([childTab('kept')]);
});

test('host-only bulk deletion keeps the existing sequential physical joins and rejects an unowned remainder', async () => {
  const first = Promise.withResolvers<readonly string[]>();
  const deletion = vi.fn(async (id: string) =>
    id === 'owned-first' ? await first.promise : undefined
  );
  const { host } = hostFixture(deletion);
  const catalog = createHostAssistantThreadRepository(host);
  if (!catalog.deleteThreads) {
    throw new Error('Host bulk deletion is missing');
  }
  const result = catalog.deleteThreads(['owned-first', 'unowned']);
  const observed = result.catch((error) => error);
  expect(deletion).toHaveBeenCalledExactlyOnceWith('owned-first');
  first.resolve(['owned-first']);
  expect(await observed).toBeInstanceOf(Error);
  expect(deletion.mock.calls).toEqual([['owned-first'], ['unowned']]);
});
