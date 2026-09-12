import { TOOL_APPROVAL_RUN_CONFIG_KEY } from '@brainstrike/assistant-contract/tool-approval';
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
        getState: () => ({ isRunning, threadId: 'root' }),
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    });
    const signal = new AbortController().signal;
    const accepted = vi.fn();
    const delivery = root
      .sendFollowup('child', { id: 'input-1', text: 'Continue' }, signal)
      .then(accepted);
    await Promise.resolve();
    expect(accepted).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledOnce();
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
          getState: () => ({ isRunning: false, threadId: 'root' }),
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
    root.onRuntimeReady({ thread: { append, getState: () => ({ threadId: 'root' }) } });
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
    await root.sendDecision('child', message);
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
    const dispose = root.onRuntimeReady({ thread: { append, getState: () => ({ threadId }) } });
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
      thread: { append: oldAppend, getState: () => ({ threadId: 'old-root' }) },
    });
    const dispose = root.onRuntimeReady({
      thread: { append, getState: () => ({ threadId: 'root' }) },
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
});
