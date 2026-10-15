// @vitest-environment node
import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import { createTestActionRegistry } from '@brainstrike/context-actions';
import { describe, expect, it } from 'vitest';
import {
  assistantThreadActions,
  assistantThreadToTarget,
} from '../assistant-thread-context-actions';

const thread: AssistantMemoryThread = {
  createdAt: new Date('2026-07-10T12:00:00Z'),
  id: 'thread-a',
  resourceId: 'workspace-memory',
  title: 'Evidence review',
  updatedAt: new Date('2026-07-10T12:00:00Z'),
};

describe('assistant thread context actions', () => {
  it('adapts rows and tabs to resource-scoped immutable target snapshots', () => {
    expect(assistantThreadToTarget(thread, 'assistant-thread')).toEqual({
      id: 'thread-a',
      kind: 'assistant-thread',
      resourceId: 'workspace-memory',
      title: 'Evidence review',
    });
    expect(assistantThreadToTarget(thread, 'assistant-thread-tab')).toEqual({
      id: 'thread-a',
      kind: 'assistant-thread-tab',
      resourceId: 'workspace-memory',
      title: 'Evidence review',
    });
  });

  it('shares exact copy-title and copy-id actions across thread rows and tabs', async () => {
    expect(assistantThreadActions.map((action) => action.id)).toEqual([
      'assistant-thread.copy-title',
      'assistant-thread.copy-id',
    ]);
    const { registry, writtenTexts } = createTestActionRegistry({
      actions: assistantThreadActions,
    });
    const rowTarget = assistantThreadToTarget(thread, 'assistant-thread');
    const tabTarget = assistantThreadToTarget(thread, 'assistant-thread-tab');
    const rowActions = registry
      .actionsFor(rowTarget)
      .flatMap((group) => group.actions.map((action) => action.id));
    const tabGroups = registry.actionsFor(tabTarget);
    const tabActions = tabGroups.flatMap((group) => group.actions);

    expect(rowActions).toEqual(['assistant-thread.copy-title', 'assistant-thread.copy-id']);
    expect(tabActions.map((action) => action.id)).toEqual(rowActions);

    await tabActions[0]?.run(tabTarget, registry.services);
    await tabActions[1]?.run(tabTarget, registry.services);
    expect(writtenTexts).toEqual(['Evidence review', 'thread-a']);
  });

  it('fails explicitly when clipboard capability wiring is absent', async () => {
    const target = assistantThreadToTarget(thread, 'assistant-thread');
    const copyTitle = assistantThreadActions[0];
    if (!copyTitle) {
      throw new Error('Expected Copy Thread Title action.');
    }

    await expect(copyTitle.run(target, {})).resolves.toEqual({
      error: 'Clipboard service unavailable',
      ok: false,
    });
  });
});
