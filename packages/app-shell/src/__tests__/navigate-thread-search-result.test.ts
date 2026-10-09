import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantThreadHostCapability } from '../assistant-thread-host-context';
import { delegatedWorkspaceTabId } from '../delegated-workspace-tab';
import { navigateThreadSearchResult } from '../navigate-thread-search-result';
import { resetThreadSearchStore, useThreadSearchStore } from '../thread-search-store';
import { threadWorkspaceNavigation } from '../thread-workspace/live-thread-workspace-navigation';

const OWNER = 'workspace-memory';

/** A host that owns `owned`, and knows each child's delegating thread. */
function host(
  owned: readonly string[],
  parents: Readonly<Record<string, string>>
): AssistantThreadHostCapability {
  return {
    ownsThread: vi.fn(async (threadId: string) => owned.includes(threadId)),
    resolveChildThread: vi.fn(async (threadId: string) => {
      const parentThreadId = parents[threadId];
      if (!parentThreadId) {
        throw new Error('The child conversation is missing or does not belong to this workspace.');
      }
      return {
        callSign: 'Cedar-1a2b3c',
        color: '#336699',
        depth: 1,
        parentRunId: 'run-1',
        parentThreadId,
        persona: 'researcher',
        threadId,
        toolCallId: 'call-1',
      };
    }),
  } as unknown as AssistantThreadHostCapability;
}

describe('navigateThreadSearchResult for host threads', () => {
  beforeEach(() => {
    resetThreadSearchStore();
    useAssistantThreadStore.setState({
      threadsByResourceId: {
        [OWNER]: [{ id: 'host-root', resourceId: OWNER } as never],
      },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens a host root thread at the matched message without asking history', async () => {
    const open = vi.spyOn(useAssistantThreadStore.getState(), 'openThreadTab');
    const history = { getNavigationTarget: vi.fn() };

    await navigateThreadSearchResult(
      history as never,
      OWNER,
      'host-root',
      'host-message',
      host(['host-root'], {})
    );

    expect(history.getNavigationTarget).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(OWNER, 'host-root');
    expect(useThreadSearchStore.getState().navigationTarget).toMatchObject({
      messageId: 'host-message',
      threadId: 'host-root',
    });
  });

  it("opens a host child's tab in its root's workspace", async () => {
    const open = vi.spyOn(threadWorkspaceNavigation, 'open').mockImplementation(() => undefined);

    await navigateThreadSearchResult(
      null,
      OWNER,
      'host-grandchild',
      undefined,
      host(['host-grandchild'], { 'host-child': 'host-root', 'host-grandchild': 'host-child' })
    );

    expect(open).toHaveBeenCalledWith(
      OWNER,
      'host-root',
      delegatedWorkspaceTabId({
        ownerResourceId: OWNER,
        rootThreadId: 'host-root',
        threadId: 'host-grandchild',
      })
    );
  });

  it('surfaces a host thread whose origin no longer resolves', async () => {
    await navigateThreadSearchResult(
      null,
      OWNER,
      'host-orphan',
      undefined,
      host(['host-orphan'], {})
    );

    expect(useThreadSearchStore.getState().navigationError).toBe(
      'The child conversation is missing or does not belong to this workspace.'
    );
  });
});
