import { TOOL_APPROVAL_RUN_CONFIG_KEY } from '@brainstrike/assistant-contract/tool-approval';
import { describe, expect, it, vi } from 'vitest';
import { createDelegatedConversationRoot } from '../delegated-conversation-root';
import { delegatedUpdate } from './helpers/delegated-conversation-fixtures';

describe('owning root registration', () => {
  it('uses the current owner, ignores obsolete cleanup, and refuses sending after disposal', async () => {
    const root = createDelegatedConversationRoot('root');
    const update = delegatedUpdate('child');
    root.onDelegatedConversation(update);
    const oldAppend = vi.fn();
    const append = vi.fn();
    // Only append is consumed by the ownership adapter; the actual runtime is
    // exercised by the shared panel and runtime-publication tests.
    const disposeOld = root.onRuntimeReady({ thread: { append: oldAppend } });
    const dispose = root.onRuntimeReady({ thread: { append } });
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
