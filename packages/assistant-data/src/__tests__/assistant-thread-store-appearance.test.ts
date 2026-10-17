import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMemoryThread } from '../assistant-memory-repository';
import { AssistantThreadAppearanceSaveError } from '../assistant-thread-appearance';
import { resetAssistantThreadStore, useAssistantThreadStore } from '../assistant-thread-store';
import { createRepository, workspaceId } from './helpers/assistant-thread-store-fixtures';

// BST-2116: a thread's icon and colour paint at once and are written after. A
// failed write puts back what the repository last accepted, and says so.

function thread(metadata: AssistantMemoryThread['metadata']): AssistantMemoryThread {
  return {
    createdAt: new Date('2026-10-17T09:00:00Z'),
    id: 'thread-a',
    ...(metadata ? { metadata } : {}),
    resourceId: workspaceId,
    title: 'A thread',
    updatedAt: new Date('2026-10-17T10:00:00Z'),
  };
}

const shown = () => useAssistantThreadStore.getState().threadsByResourceId[workspaceId]?.[0];

async function loaded(metadata: AssistantMemoryThread['metadata']) {
  const repository = createRepository([thread(metadata)]);
  await useAssistantThreadStore.getState().ensureResourceThreads(repository, workspaceId);
  return repository;
}

const pick = (
  repository: Awaited<ReturnType<typeof loaded>>,
  patch: Parameters<
    ReturnType<typeof useAssistantThreadStore.getState>['updateThreadAppearance']
  >[3]
) =>
  useAssistantThreadStore
    .getState()
    .updateThreadAppearance(repository, workspaceId, 'thread-a', patch);

describe('useAssistantThreadStore thread appearance', () => {
  beforeEach(() => {
    resetAssistantThreadStore();
  });

  it('shows a pick before its write settles, and keeps it once written', async () => {
    const repository = await loaded({ color: 'blue', icon: 'message' });
    const write = Promise.withResolvers<void>();
    vi.mocked(repository.updateThreadMetadata).mockReturnValueOnce(write.promise);

    const saved = pick(repository, { color: 'rose' });

    expect(shown()?.metadata).toEqual({ color: 'rose', icon: 'message' });
    expect(repository.updateThreadMetadata).toHaveBeenCalledWith('thread-a', { color: 'rose' });
    write.resolve();
    await saved;
    expect(shown()?.metadata).toEqual({ color: 'rose', icon: 'message' });
  });

  it('puts the accepted value back when the write fails, and says it did', async () => {
    const repository = await loaded({ color: 'blue', icon: 'message' });
    vi.mocked(repository.updateThreadMetadata).mockRejectedValueOnce(new Error('disk full'));

    const failure = await pick(repository, { icon: 'bug' }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AssistantThreadAppearanceSaveError);
    expect(failure).toMatchObject({ message: 'disk full', rolledBack: true });
    expect(shown()?.metadata).toEqual({ color: 'blue', icon: 'message' });
  });

  it('removes a key the thread did not have before the failed pick', async () => {
    const repository = await loaded(undefined);
    vi.mocked(repository.updateThreadMetadata).mockRejectedValueOnce(new Error('offline'));

    await expect(pick(repository, { color: 'rose' })).rejects.toMatchObject({ rolledBack: true });

    expect(shown()?.metadata).toEqual({});
  });

  it('leaves a newer pick of the same key shown when an older one fails', async () => {
    const repository = await loaded({ color: 'blue' });
    const older = Promise.withResolvers<void>();
    const newer = Promise.withResolvers<void>();
    vi.mocked(repository.updateThreadMetadata)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    const first = pick(repository, { color: 'rose' }).catch((error: unknown) => error);
    const second = pick(repository, { color: 'green' });
    older.reject(new Error('lost'));

    expect(await first).toMatchObject({ rolledBack: false });
    expect(shown()?.metadata).toEqual({ color: 'green' });
    newer.resolve();
    await second;
    expect(shown()?.metadata).toEqual({ color: 'green' });
  });

  it('returns to the last accepted value, not a failed pick, when two picks fail', async () => {
    const repository = await loaded({ color: 'blue' });
    const older = Promise.withResolvers<void>();
    const newer = Promise.withResolvers<void>();
    vi.mocked(repository.updateThreadMetadata)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    const first = pick(repository, { color: 'rose' }).catch((error: unknown) => error);
    const second = pick(repository, { color: 'green' }).catch((error: unknown) => error);
    older.reject(new Error('lost'));
    newer.reject(new Error('lost again'));

    expect(await first).toMatchObject({ rolledBack: false });
    expect(await second).toMatchObject({ rolledBack: true });
    expect(shown()?.metadata).toEqual({ color: 'blue' });
  });

  it('reverts to a pick the repository accepted after an earlier one succeeded', async () => {
    const repository = await loaded({ color: 'blue' });
    await pick(repository, { color: 'rose' });
    vi.mocked(repository.updateThreadMetadata).mockRejectedValueOnce(new Error('lost'));

    await expect(pick(repository, { color: 'green' })).rejects.toMatchObject({
      rolledBack: true,
    });

    expect(shown()?.metadata).toEqual({ color: 'rose' });
  });

  it('refuses a patch carrying anything but icon and colour', async () => {
    const repository = await loaded({ color: 'blue' });

    await expect(
      useAssistantThreadStore
        .getState()
        .updateThreadAppearance(repository, workspaceId, 'thread-a', {
          color: 'rose',
          model: 'gpt-5.2',
        } as never)
    ).rejects.toThrow(/only icon and color: model/);
    expect(repository.updateThreadMetadata).not.toHaveBeenCalled();
    expect(shown()?.metadata).toEqual({ color: 'blue' });
  });
});

describe('useAssistantThreadStore thread appearance during a refresh', () => {
  beforeEach(() => {
    resetAssistantThreadStore();
  });

  // A refresh that read the repository before a pick still brings that read's
  // other fields; only the keys changed here meanwhile keep their local value.
  it('keeps the pending pick and takes the refresh’s other fields', async () => {
    const repository = await loaded({ color: 'blue', icon: 'message', model: 'gpt-5.2' });
    const read = Promise.withResolvers<readonly AssistantMemoryThread[]>();
    vi.mocked(repository.listThreads).mockReturnValueOnce(read.promise);
    const write = Promise.withResolvers<void>();
    vi.mocked(repository.updateThreadMetadata).mockReturnValueOnce(write.promise);

    const refresh = useAssistantThreadStore
      .getState()
      .refreshResourceThreads(repository, workspaceId);
    const saved = pick(repository, { color: 'rose' });
    read.resolve([thread({ color: 'blue', icon: 'message', model: 'gpt-5.5' })]);
    await refresh;

    expect(shown()?.metadata).toEqual({ color: 'rose', icon: 'message', model: 'gpt-5.5' });
    write.resolve();
    await saved;
    expect(shown()?.metadata).toEqual({ color: 'rose', icon: 'message', model: 'gpt-5.5' });
  });
});
