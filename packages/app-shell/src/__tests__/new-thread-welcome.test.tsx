import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import {
  type AssistantMemoryThread,
  type AssistantThreadCatalogRepository,
  resetAssistantThreadStore,
  useAssistantThreadStore,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssistantComposerCommandStore } from '../assistant-composer-command-store';
import { NewThreadWelcome } from '../new-thread-welcome';

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  toast: toastMock,
}));

const resourceId = WORKSPACE_MEMORY_RESOURCE_ID;
const folder = { displayName: 'brainstrike', path: '/repo/brainstrike', rootId: 'root-1' };

function created(id: string): AssistantMemoryThread {
  return {
    createdAt: new Date('2026-10-27T00:00:00Z'),
    id,
    resourceId,
    title: 'New Thread',
    updatedAt: new Date('2026-10-27T00:00:00Z'),
  };
}

function fakeRepository(): AssistantThreadCatalogRepository & {
  readonly createThread: ReturnType<typeof vi.fn>;
  readonly updateThreadMetadata: ReturnType<typeof vi.fn>;
} {
  return {
    createThread: vi.fn(async () => created('thread-1')),
    deleteThread: vi.fn(),
    deleteThreads: vi.fn(),
    listThreads: vi.fn(async () => []),
    renameThread: vi.fn(),
    updateThreadMetadata: vi.fn(async () => undefined),
  };
}

function queued(threadId: string) {
  return useAssistantComposerCommandStore.getState().commandsByThreadId[threadId];
}

function renderWelcome(repository: AssistantThreadCatalogRepository) {
  useAssistantThreadStore.setState({
    loadStateByResourceId: { [resourceId]: { status: 'ready' } },
    threadsByResourceId: { [resourceId]: [] },
  });
  return render(<NewThreadWelcome repository={repository} resourceId={resourceId} />);
}

beforeEach(() => {
  resetAssistantThreadStore();
  useAssistantComposerCommandStore.getState().reset();
  toastMock.mockClear();
});
afterEach(cleanup);

describe('NewThreadWelcome', () => {
  it('creates nothing until a message is sent, then hands the message to the new thread', async () => {
    const repository = fakeRepository();
    renderWelcome(repository);
    const user = userEvent.setup();
    const input = screen.getByRole('textbox', { name: 'Message input' });

    expect(input).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await user.type(input, '   ');
    await user.keyboard('{Enter}');
    expect(repository.createThread).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, 'First line{Shift>}{Enter}{/Shift}second line');
    expect(input).toHaveValue('First line\nsecond line');
    expect(repository.createThread).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(queued('thread-1')).toHaveLength(1));
    expect(repository.createThread).toHaveBeenCalledExactlyOnceWith(resourceId, undefined);
    expect(queued('thread-1')?.[0]).toMatchObject({
      mode: 'send',
      text: 'First line\nsecond line',
    });
    expect(useAssistantThreadStore.getState().activeThreadIdByResourceId[resourceId]).toBe(
      'thread-1'
    );
    expect(repository.updateThreadMetadata).not.toHaveBeenCalled();
  });

  it('binds a thread started from a folder in one write before its message is sent', async () => {
    const repository = fakeRepository();
    let queuedAtBinding: unknown;
    repository.updateThreadMetadata.mockImplementation(async () => {
      queuedAtBinding = queued('thread-1');
    });
    useAssistantThreadStore.getState().startNewThread(resourceId, folder);
    renderWelcome(repository);
    const user = userEvent.setup();

    expect(screen.getByTestId('new-thread-folder')).toHaveTextContent('brainstrike');
    await user.type(screen.getByRole('textbox', { name: 'Message input' }), 'Fix the build{Enter}');

    await waitFor(() => expect(queued('thread-1')).toHaveLength(1));
    expect(repository.updateThreadMetadata).toHaveBeenCalledExactlyOnceWith('thread-1', {
      operatingRootDisplayName: 'brainstrike',
      operatingRootId: 'root-1',
      operatingRootPath: '/repo/brainstrike',
    });
    // The send waits for the binding, so the thread never starts in another folder.
    expect(queuedAtBinding).toBeUndefined();
    expect(queued('thread-1')?.[0]).toMatchObject({ mode: 'send', text: 'Fix the build' });
    expect(useAssistantThreadStore.getState().newThreadFolderByResourceId).toEqual({});
  });

  it('binds a pathless folder by its root id and name alone', async () => {
    const repository = fakeRepository();
    useAssistantThreadStore
      .getState()
      .startNewThread(resourceId, { displayName: 'notes', path: null, rootId: 'root-web-1' });
    renderWelcome(repository);

    await userEvent
      .setup()
      .type(screen.getByRole('textbox', { name: 'Message input' }), 'Summarize{Enter}');

    await waitFor(() => expect(repository.updateThreadMetadata).toHaveBeenCalledOnce());
    expect(repository.updateThreadMetadata).toHaveBeenCalledWith('thread-1', {
      operatingRootDisplayName: 'notes',
      operatingRootId: 'root-web-1',
    });
  });

  it('leaves the message unsent in the thread when its folder binding is refused', async () => {
    const repository = fakeRepository();
    repository.updateThreadMetadata.mockRejectedValueOnce(new Error('binding unavailable'));
    useAssistantThreadStore.getState().startNewThread(resourceId, folder);
    renderWelcome(repository);

    await userEvent
      .setup()
      .type(screen.getByRole('textbox', { name: 'Message input' }), 'Fix the build{Enter}');

    await waitFor(() => expect(toastMock).toHaveBeenCalledOnce());
    expect(toastMock).toHaveBeenCalledWith({
      description: `Could not bind it to brainstrike. Select brainstrike in the thread, then send your message. Error: ${INTERNAL_FAULT.message}`,
      title: 'Thread created in No folder',
      variant: 'destructive',
    });
    expect(queued('thread-1')).toEqual([
      expect.objectContaining({ mode: 'replace', text: 'Fix the build' }),
    ]);
  });

  it('keeps the message and says so when the thread cannot be created', async () => {
    const repository = fakeRepository();
    repository.createThread.mockRejectedValueOnce(new Error('host unavailable'));
    renderWelcome(repository);
    const input = screen.getByRole('textbox', { name: 'Message input' });

    await userEvent.setup().type(input, 'Hello{Enter}');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      `Could not start the thread: ${INTERNAL_FAULT.message}`
    );
    expect(input).toHaveValue('Hello');
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    expect(useAssistantComposerCommandStore.getState().commandsByThreadId).toEqual({});
  });
});
