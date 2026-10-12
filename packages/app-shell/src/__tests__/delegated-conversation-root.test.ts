import { TOOL_APPROVAL_RUN_CONFIG_KEY } from '@brainstrike/assistant-contract/tool-approval';
import {
  followUpQueueKey,
  resetFollowUpQueueStore,
  useFollowUpQueueStore,
} from '@brainstrike/assistant-ui/follow-up-queue-store';
import { describe, expect, it, vi } from 'vitest';
import { createDelegatedConversationRoot } from '../delegated-conversation-owner';
import { delegatedUpdate } from './helpers/delegated-conversation-fixtures';

describe('owning root registration', () => {
  it('acknowledges an idle follow-up only from the matching host envelope, and rejects a failed start', async () => {
    const root = createDelegatedConversationRoot('root');
    const listeners = new Set<() => void>();
    let isRunning = false;
    const append = vi.fn(() => {
      isRunning = true;
      for (const listener of listeners) {
        listener();
      }
    });
    root.onRuntimeReady({
      thread: {
        append,
        getState: () => ({ isRunning, messages: [], threadId: 'root' }),
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    });
    const signal = new AbortController().signal;
    const accepted = vi.fn();
    const delivery = root
      .sendFollowup(
        'child',
        {
          attachments: [
            { data: 'data:image/png;base64,AQID', mediaType: 'image/png', type: 'file' },
          ],
          id: 'input-1',
          text: '',
        },
        signal
      )
      .then(accepted);
    await Promise.resolve();
    expect(accepted).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [{ text: '', type: 'text' }],
        runConfig: {
          custom: {
            brainstrikeChildFollowup: {
              attachments: [
                { data: 'data:image/png;base64,AQID', mediaType: 'image/png', type: 'file' },
              ],
              id: 'input-1',
              text: '',
              threadId: 'child',
            },
          },
        },
      })
    );
    const { identity: _identity, ...snapshot } = delegatedUpdate('child', 'new-host');
    root.onDelegatedConversation({
      ...snapshot,
      continuation: {
        continuationId: 'input-1',
        nativeRunId: 'new-native',
        threadId: 'child',
      },
    });
    await delivery;
    expect(accepted).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
    isRunning = false;
    const rejected = root.sendFollowup('child', { id: 'input-2', text: 'Again' }, signal);
    const failure = expect(rejected).rejects.toThrow(/not confirmed/i);
    isRunning = false;
    for (const listener of [...listeners]) {
      listener();
    }
    await failure;
    expect(listeners.size).toBe(0);
  });
  it.each([new Error('HTTP continuation admission failed'), undefined, null, ''])(
    'observes an asynchronous owning-runtime append failure %j without a dangling receipt',
    async (failure) => {
      const root = createDelegatedConversationRoot('root');
      const result = Promise.withResolvers<void>();
      // Capture the underlying promise in this negative-control test too, so the
      // missing production catch fails the assertion rather than leaking a worker rejection.
      const observed = vi.fn();
      void result.promise.catch(observed);
      const cleanup = vi.fn();
      root.onRuntimeReady({
        thread: {
          append: () => result.promise,
          getState: () => ({ isRunning: false, messages: [], threadId: 'root' }),
          subscribe: () => cleanup,
        },
      });
      const accepted = vi.fn();
      const rejected = vi.fn();
      const waiting = root
        .sendFollowup(
          'child',
          { id: 'async-error', text: 'Continue' },
          new AbortController().signal
        )
        .then(accepted, rejected);
      result.reject(failure);
      await result.promise.catch(() => undefined);
      await Promise.resolve();
      await Promise.resolve();
      expect(rejected).toHaveBeenCalledWith(
        failure instanceof Error ? failure : expect.objectContaining({ cause: failure })
      );
      await waiting;
      expect(accepted).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalledOnce();
    }
  );

  it.each(['', 0, false])(
    'rejects an acknowledgement wait aborted with falsy reason %j',
    async (reason) => {
      const root = createDelegatedConversationRoot('root');
      const cleanup = vi.fn();
      const append = vi.fn();
      root.onRuntimeReady({
        thread: {
          append,
          getState: () => ({ isRunning: false, messages: [], threadId: 'root' }),
          subscribe: () => cleanup,
        },
      });
      const controller = new AbortController();
      const accepted = vi.fn();
      const rejected = vi.fn();
      const waiting = root
        .sendFollowup('child', { id: 'cancelled-input', text: 'Continue' }, controller.signal)
        .then(accepted, rejected);
      controller.abort(reason);
      await waiting;
      expect(accepted).not.toHaveBeenCalled();
      expect(rejected).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
    }
  );

  it('routes a continuation decision only to its exact fresh native run', async () => {
    const root = createDelegatedConversationRoot('root');
    const { identity: _identity, ...snapshot } = delegatedUpdate('child', 'new-host');
    const continuation = {
      continuationId: 'input-1',
      nativeRunId: 'new-native',
      threadId: 'child',
    };
    root.onDelegatedConversation({ ...snapshot, continuation });
    const append = vi.fn();
    root.onRuntimeReady({
      thread: {
        append,
        getState: () => ({ messages: [], threadId: 'root' }),
        subscribe: () => () => undefined,
      },
    });
    const action = {
      action: 'approve',
      continuationId: 'input-1',
      runId: 'new-native',
      toolCallId: 'write',
    };
    const custom = { [TOOL_APPROVAL_RUN_CONFIG_KEY]: action };
    const message = {
      attachments: [],
      content: [{ text: 'Approved.', type: 'text' as const }],
      createdAt: new Date(),
      metadata: { custom },
      parentId: 'child-row',
      role: 'user' as const,
      runConfig: { custom },
      sourceId: null,
      startRun: true,
    };
    await expect(root.sendDecision('child', message)).resolves.toBe('sent');
    expect(append).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ runConfig: { custom } })
    );
    expect(append.mock.calls[0]?.[0]).not.toHaveProperty('parentId');
    await expect(
      root.sendDecision('child', {
        ...message,
        runConfig: {
          custom: {
            [TOOL_APPROVAL_RUN_CONFIG_KEY]: { ...action, runId: 'previous-native' },
          },
        },
      })
    ).rejects.toThrow(/does not belong/i);
    expect(append).toHaveBeenCalledOnce();
  });
  it('queues a child decision behind a running root run instead of cancelling it', async () => {
    // Appending during a run cancels the run in the installed runtime; the
    // second of two quick decisions aborted the first's resume leg and was
    // lost (thread-b3cea1f6, 2026-09-14). The child view's decision obeys the
    // same rule as the root card: it waits in the root's follow-up queue.
    resetFollowUpQueueStore();
    const root = createDelegatedConversationRoot('root');
    const { identity: _identity, ...snapshot } = delegatedUpdate('child', 'new-host');
    const continuation = {
      continuationId: 'input-1',
      nativeRunId: 'new-native',
      threadId: 'child',
    };
    root.onDelegatedConversation({ ...snapshot, continuation });
    const append = vi.fn();
    let isRunning = true;
    root.onRuntimeReady({
      thread: {
        append,
        // Runtime-local identity differs from the persisted queue owner.
        getState: () => ({ isRunning, messages: [], threadId: 'runtime-local-root' }),
        subscribe: () => () => undefined,
      },
    });
    const action = {
      action: 'approve',
      continuationId: 'input-1',
      runId: 'new-native',
      toolCallId: 'write',
    };
    const custom = { [TOOL_APPROVAL_RUN_CONFIG_KEY]: action };
    const message = {
      attachments: [],
      content: [{ text: 'Approved write.', type: 'text' as const }],
      createdAt: new Date(),
      metadata: { custom },
      parentId: 'child-row',
      role: 'user' as const,
      runConfig: { custom },
      sourceId: null,
      startRun: true,
    };
    await expect(root.sendDecision('child', message)).resolves.toBe('queued');
    expect(append).not.toHaveBeenCalled();
    const queued = useFollowUpQueueStore.getState().queuedByThread[followUpQueueKey('root')];
    expect(queued).toHaveLength(1);
    expect(queued?.[0]).toMatchObject({
      identityKey: JSON.stringify(['input-1', 'new-native', 'write']),
      message: expect.objectContaining({ runConfig: { custom } }),
      text: 'Approved write.',
    });
    expect(queued?.[0]?.message).not.toHaveProperty('parentId');
    // Idle root: the same decision appends at once.
    resetFollowUpQueueStore();
    isRunning = false;
    await expect(root.sendDecision('child', message)).resolves.toBe('sent');
    expect(append).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ runConfig: { custom } })
    );
  });

  it('dispatches a persisted decision without live snapshots and refuses a disposed owner after lookup', async () => {
    const root = createDelegatedConversationRoot('root');
    const update = delegatedUpdate('child');
    const custom = {
      [TOOL_APPROVAL_RUN_CONFIG_KEY]: {
        action: 'approve',
        delegation: { path: [update.identity], toolCallId: 'write' },
        runId: 'parent',
        toolCallId: 'call-child',
      },
    };
    const message = {
      attachments: [],
      content: [{ text: 'Approved.', type: 'text' as const }],
      createdAt: new Date(),
      metadata: { custom },
      parentId: 'saved-child-row',
      role: 'user' as const,
      runConfig: { custom },
      sourceId: null,
      startRun: true,
    };
    const resolve = vi.fn(async () => update.identity);
    await expect(root.sendDecision('child', message, resolve)).rejects.toThrow(
      'owning conversation'
    );
    expect(resolve).not.toHaveBeenCalled();
    const append = vi.fn();
    let threadId = 'registered-root';
    const dispose = root.onRuntimeReady({
      thread: {
        append,
        getState: () => ({ messages: [], threadId }),
        subscribe: () => () => undefined,
      },
    });
    await root.sendDecision('child', message, resolve);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[0]).not.toHaveProperty('parentId');
    threadId = 'different-root';
    await expect(root.sendDecision('child', message, resolve)).rejects.toThrow(
      'owning conversation'
    );
    expect(append).toHaveBeenCalledTimes(1);
    threadId = 'registered-root';
    await expect(
      root.sendDecision('child', message, async () => {
        dispose();
        return update.identity;
      })
    ).rejects.toThrow('owning conversation');
    expect(append).toHaveBeenCalledTimes(1);
  });

  it('uses the current owner, ignores obsolete cleanup, and refuses sending after disposal', async () => {
    const root = createDelegatedConversationRoot('root');
    const update = delegatedUpdate('child');
    root.onDelegatedConversation(update);
    const oldAppend = vi.fn();
    const append = vi.fn();
    // The adapter consumes the bound thread identity and append; the actual runtime is
    // exercised by the shared panel and runtime-publication tests.
    const disposeOld = root.onRuntimeReady({
      thread: {
        append: oldAppend,
        getState: () => ({ messages: [], threadId: 'old-root' }),
        subscribe: () => () => undefined,
      },
    });
    const dispose = root.onRuntimeReady({
      thread: {
        append,
        getState: () => ({ messages: [], threadId: 'root' }),
        subscribe: () => () => undefined,
      },
    });
    disposeOld();
    const action = {
      action: 'approve',
      delegation: { path: [update.identity], toolCallId: 'write' },
      runId: 'parent',
      toolCallId: 'call-child',
    };
    const custom = { [TOOL_APPROVAL_RUN_CONFIG_KEY]: action };
    const message = {
      attachments: [],
      content: [{ text: 'Approved.', type: 'text' as const }],
      createdAt: new Date(),
      metadata: { custom },
      parentId: 'child-row',
      role: 'user' as const,
      runConfig: { custom },
      sourceId: null,
      startRun: true,
    };
    await root.sendDecision('child', message);
    expect(append).toHaveBeenCalledTimes(1);
    expect(oldAppend).not.toHaveBeenCalled();
    dispose();
    await expect(root.sendDecision('child', message)).rejects.toThrow('owning conversation');
    expect(append).toHaveBeenCalledTimes(1);
    expect(root.store.getConversation('child')?.update).toBe(update);
  });

  it('publishes the registered owning thread to child views and retires it only with that registration', () => {
    // A child view reads the root's host answers from this thread
    // (`ApprovalOwnerThreadContext`); the host answers a child's approval on
    // the root leg only.
    const root = createDelegatedConversationRoot('root');
    const thread = (threadId: string) => ({
      append: vi.fn(),
      getState: () => ({ isRunning: false, messages: [], threadId }),
      subscribe: () => () => undefined,
    });
    const notified = vi.fn();
    const unsubscribe = root.subscribeOwner(notified);
    expect(root.getOwnerThread()).toBeUndefined();
    const old = thread('old-root');
    const disposeOld = root.onRuntimeReady({ thread: old });
    expect(root.getOwnerThread()).toBe(old);
    expect(notified).toHaveBeenCalledTimes(1);
    const current = thread('root');
    const dispose = root.onRuntimeReady({ thread: current });
    expect(root.getOwnerThread()).toBe(current);
    expect(notified).toHaveBeenCalledTimes(2);
    disposeOld();
    expect(root.getOwnerThread()).toBe(current);
    expect(notified).toHaveBeenCalledTimes(2);
    dispose();
    expect(root.getOwnerThread()).toBeUndefined();
    expect(notified).toHaveBeenCalledTimes(3);
    unsubscribe();
    root.onRuntimeReady({ thread: thread('root') });
    expect(notified).toHaveBeenCalledTimes(3);
  });
});
