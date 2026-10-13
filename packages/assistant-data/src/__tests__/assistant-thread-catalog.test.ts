import { beforeEach, expect, it, vi } from 'vitest';
import { resetAssistantThreadStore, useAssistantThreadStore } from '../assistant-thread-store';
import { createRepository, workspaceId } from './helpers/assistant-thread-store-fixtures';

beforeEach(resetAssistantThreadStore);
it('clears unavailable saved tabs after a successful empty catalog even when creation fails', async () => {
  const repository = createRepository([]);
  const failure = new Error('The selected workspace root is no longer mounted.');
  vi.mocked(repository.createThread).mockRejectedValueOnce(failure);
  useAssistantThreadStore.setState({
    activeThreadIdByResourceId: { [workspaceId]: 'retired-thread' },
    openThreadIdsByResourceId: { [workspaceId]: ['retired-thread'] },
    selectedThreadByResourceId: { [workspaceId]: 'retired-thread' },
  });
  await expect(
    useAssistantThreadStore.getState().ensureResourceThreads(repository, workspaceId)
  ).rejects.toBe(failure);
  const state = useAssistantThreadStore.getState();
  expect(state.activeThreadIdByResourceId[workspaceId]).toBeUndefined();
  expect(state.selectedThreadByResourceId[workspaceId]).toBeUndefined();
  expect(state.openThreadIdsByResourceId[workspaceId]).toEqual([]);
  expect(state.threadsByResourceId[workspaceId]).toEqual([]);
  expect(repository.deleteThread).not.toHaveBeenCalled();
  expect(state.loadStateByResourceId[workspaceId]).toEqual({
    error: failure.message,
    status: 'error',
  });
  await useAssistantThreadStore.getState().createThread(repository, workspaceId);
  expect(useAssistantThreadStore.getState().loadStateByResourceId[workspaceId]).toEqual({
    status: 'ready',
  });
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
  expect(repository.createThread).toHaveBeenCalledTimes(1);
  expect(useAssistantThreadStore.getState().loadStateByResourceId[workspaceId]).toEqual({
    status: 'ready',
  });
});
