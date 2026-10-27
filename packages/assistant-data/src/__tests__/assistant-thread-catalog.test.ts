import { beforeEach, expect, it, vi } from 'vitest';
import { newThreadId } from '../assistant-new-thread';
import { resetAssistantThreadStore, useAssistantThreadStore } from '../assistant-thread-store';
import { createRepository, workspaceId } from './helpers/assistant-thread-store-fixtures';

beforeEach(resetAssistantThreadStore);
it('clears unavailable saved tabs after a successful empty catalog without creating a thread', async () => {
  const repository = createRepository([]);
  useAssistantThreadStore.setState({
    activeThreadIdByResourceId: { [workspaceId]: 'retired-thread' },
    openThreadIdsByResourceId: { [workspaceId]: ['retired-thread'] },
    selectedThreadByResourceId: { [workspaceId]: 'retired-thread' },
  });
  await useAssistantThreadStore.getState().ensureResourceThreads(repository, workspaceId);
  const state = useAssistantThreadStore.getState();
  expect(state.activeThreadIdByResourceId[workspaceId]).toBeUndefined();
  expect(state.selectedThreadByResourceId[workspaceId]).toBeUndefined();
  expect(state.openThreadIdsByResourceId[workspaceId]).toEqual([]);
  expect(state.threadsByResourceId[workspaceId]).toEqual([]);
  expect(state.unavailableSavedThreadByResourceId[workspaceId]).toBe('retired-thread');
  expect(state.loadStateByResourceId[workspaceId]).toEqual({ status: 'ready' });
  // An empty catalog is the new-thread screen; the first send creates the thread.
  expect(repository.createThread).not.toHaveBeenCalled();
  expect(repository.deleteThread).not.toHaveBeenCalled();
});

it('holds a new thread as a draft until its first send commits it as the active tab', async () => {
  const repository = createRepository([]);
  useAssistantThreadStore.setState({
    activeThreadIdByResourceId: { [workspaceId]: 'thread-a' },
    draftRuntimeByThreadId: { [newThreadId(workspaceId)]: { model: 'draft-model' } },
    openThreadIdsByResourceId: { [workspaceId]: ['thread-a'] },
    selectedThreadByResourceId: { [workspaceId]: 'thread-a' },
    threadsByResourceId: { [workspaceId]: [] },
  });
  const folder = { displayName: 'repo', path: '/repo', rootId: 'root-1' };
  useAssistantThreadStore.getState().startNewThread(workspaceId, folder);
  let state = useAssistantThreadStore.getState();
  expect(state.activeThreadIdByResourceId[workspaceId]).toBeUndefined();
  expect(state.openThreadIdsByResourceId[workspaceId]).toEqual(['thread-a']);
  expect(state.newThreadMetadataByResourceId[workspaceId]).toEqual({
    operatingRootDisplayName: 'repo',
    operatingRootId: 'root-1',
    operatingRootPath: '/repo',
  });

  // The composer's workspace writes land on the draft; nothing reaches the repository.
  await state.updateThreadMetadata(repository, workspaceId, newThreadId(workspaceId), {
    checkoutMode: 'worktree',
    checkoutWorktreeId: 'wt-1',
    checkoutWorktreePath: '/repo-wt',
  });
  expect(repository.updateThreadMetadata).not.toHaveBeenCalled();
  expect(useAssistantThreadStore.getState().newThreadMetadataByResourceId[workspaceId]).toEqual(
    expect.objectContaining({ checkoutMode: 'worktree', operatingRootId: 'root-1' })
  );
  expect(repository.createThread).not.toHaveBeenCalled();

  const created = {
    createdAt: new Date(),
    id: 'thread-new',
    resourceId: workspaceId,
    title: 'New Thread',
    updatedAt: new Date(),
  };
  await useAssistantThreadStore.getState().commitNewThread(workspaceId, created);
  state = useAssistantThreadStore.getState();
  expect(state.activeThreadIdByResourceId[workspaceId]).toBe('thread-new');
  expect(state.openThreadIdsByResourceId[workspaceId]).toEqual(['thread-a', 'thread-new']);
  expect(state.newThreadMetadataByResourceId).toEqual({});
  // The new thread takes the draft's model settings.
  expect(state.draftRuntimeByThreadId).toEqual({ 'thread-new': { model: 'draft-model' } });
  expect(repository.createThread).not.toHaveBeenCalled();
});

it('does not discard saved tabs when the authoritative catalog fails to load', async () => {
  const repository = createRepository([]);
  const failure = new Error('Host catalog unavailable');
  vi.mocked(repository.listThreads).mockRejectedValueOnce(failure);
  useAssistantThreadStore.setState({
    activeThreadIdByResourceId: { [workspaceId]: 'current-thread' },
    openThreadIdsByResourceId: { [workspaceId]: ['current-thread'] },
    selectedThreadByResourceId: { [workspaceId]: 'current-thread' },
  });
  await expect(
    useAssistantThreadStore.getState().ensureResourceThreads(repository, workspaceId)
  ).rejects.toBe(failure);
  expect(useAssistantThreadStore.getState().activeThreadIdByResourceId[workspaceId]).toBe(
    'current-thread'
  );
  expect(useAssistantThreadStore.getState().openThreadIdsByResourceId[workspaceId]).toEqual([
    'current-thread',
  ]);
  expect(repository.createThread).not.toHaveBeenCalled();
});

it('a successful New cannot replace a failed authoritative catalog read', async () => {
  const repository = createRepository([]);
  vi.mocked(repository.listThreads).mockRejectedValueOnce(new Error('Host catalog unavailable'));
  useAssistantThreadStore.setState({
    activeThreadIdByResourceId: { [workspaceId]: 'saved-current' },
    openThreadIdsByResourceId: { [workspaceId]: ['saved-current'] },
    selectedThreadByResourceId: { [workspaceId]: 'saved-current' },
  });
  await expect(
    useAssistantThreadStore.getState().ensureResourceThreads(repository, workspaceId)
  ).rejects.toThrow('Host catalog unavailable');
  await expect(
    useAssistantThreadStore.getState().createThread(repository, workspaceId)
  ).rejects.toThrow('Host catalog unavailable');
  expect(repository.createThread).not.toHaveBeenCalled();
  expect(useAssistantThreadStore.getState().loadStateByResourceId[workspaceId]).toEqual({
    error: 'Host catalog unavailable',
    status: 'error',
  });
  expect(useAssistantThreadStore.getState().activeThreadIdByResourceId[workspaceId]).toBe(
    'saved-current'
  );
  await useAssistantThreadStore.getState().ensureResourceThreads(repository, workspaceId);
  expect(repository.listThreads).toHaveBeenCalledTimes(2);
  expect(repository.createThread).not.toHaveBeenCalled();
  expect(useAssistantThreadStore.getState().loadStateByResourceId[workspaceId]).toEqual({
    status: 'ready',
  });
});
