// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {
  TOOL_APPROVAL_DATA_NAME,
  TOOL_APPROVAL_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-approval';
import { restoreDelegatedConversationHistory } from '@brainstrike/assistant-data';
import { ThreadMessageNavigationContext } from '@brainstrike/assistant-ui';
import { TooltipProvider } from '@brainstrike/ui';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { DelegatedConversationPanel } from '../delegated-conversation-panel';
import { createDelegatedConversationStore } from '../delegated-conversation-store';
import { createDelegatedDecisionDispatcher } from '../delegated-decision-dispatcher';
import { delegatedUpdate } from './helpers/delegated-conversation-fixtures';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('host-owned child panel', () => {
  it('opens persisted history without executing and replaces it with a live host continuation', async () => {
    const store = createDelegatedConversationStore('root');
    const onNew = vi.fn(async () => undefined);
    render(
      <TooltipProvider>
        <DelegatedConversationPanel
          label="Cedar"
          onNew={onNew}
          persistedHistory={restoreDelegatedConversationHistory({
            hostRunId: 'saved',
            messages: [
              {
                content: 'Saved child output.',
                createdAt: '2026-09-10T00:00:00.000Z',
                id: 'saved',
                role: 'assistant',
              },
            ],
            runEvents: [],
            threadId: 'child',
          })}
          store={store}
          threadId="child"
        />
      </TooltipProvider>
    );
    expect(await screen.findByText('Saved child output.')).toBeVisible();
    expect(onNew).not.toHaveBeenCalled();
    await act(async () => {
      store.publish(delegatedUpdate('child', 'resumed', 'Live continuation.'));
    });
    expect(await screen.findByText('Live continuation.')).toBeVisible();
    expect(screen.queryByText('Saved child output.')).not.toBeInTheDocument();
    expect(onNew).not.toHaveBeenCalled();
  });

  it('extends older search context without duplicating an overlapping group or prepending a newer read', async () => {
    vi.stubGlobal('CSS', { escape: (id: string) => id });
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    onTestFinished(() => {
      if (descriptor) {
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', descriptor);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
      }
    });
    const onComplete = vi.fn();
    const store = createDelegatedConversationStore('root');
    const initial = delegatedUpdate('child', 'overlap', 'Live continuation.');
    if (!initial.baseline) {
      throw new Error('Fixture requires a baseline');
    }
    const native = (id: string, text: string, minute: number, role: string) => ({
      content: text,
      createdAt: new Date(Date.UTC(2026, 8, 10, 0, minute)).toISOString(),
      id,
      role,
    });
    const baseline = {
      ...initial.baseline,
      messages: [
        native('b', 'Host answer.', 2, 'assistant'),
        native('c', 'New prompt.', 3, 'user'),
      ],
    };
    store.publish({ ...initial, baseline });
    const loaded = restoreDelegatedConversationHistory({
      ...baseline,
      messages: [
        native('older', 'Earlier prompt.', 0, 'user'),
        native('a', 'Old snapshot.', 1, 'assistant'),
        native('b', 'Host answer.', 2, 'assistant'),
        native('c', 'New prompt.', 3, 'user'),
        native('newer', 'Read advanced beyond host.', 4, 'assistant'),
      ],
    });
    render(
      <TooltipProvider>
        <ThreadMessageNavigationContext value={{ messageId: 'a', onComplete, requestId: 1 }}>
          <DelegatedConversationPanel
            extendHistoryForSearch
            label="Cedar"
            onNew={vi.fn()}
            persistedHistory={loaded}
            store={store}
            threadId="child"
          />
        </ThreadMessageNavigationContext>
      </TooltipProvider>
    );
    expect(await screen.findByText('Earlier prompt.')).toBeVisible();
    expect(screen.getAllByText('Host answer.')).toHaveLength(1);
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith());
    expect(document.activeElement?.getAttribute('data-message-id')).toBe('b');
    expect(screen.queryByText('Old snapshot.')).not.toBeInTheDocument();
    expect(screen.queryByText('Read advanced beyond host.')).not.toBeInTheDocument();
    expect(screen.getByText('New prompt.')).toBeVisible();
    expect(screen.getByText('Live continuation.')).toBeVisible();
  });

  it('sends the visible leaf approval through the owning root without child transcript ids', async () => {
    const user = userEvent.setup();
    const store = createDelegatedConversationStore('root');
    const update = delegatedUpdate('child', 'initial', 'Awaiting permission.');
    update.message.status = { reason: 'unknown', type: 'complete' };
    const target = {
      delegation: { path: [{ ...update.identity }], toolCallId: 'write' },
      runId: 'parent',
      toolCallId: 'call-child',
    };
    update.message.parts.push({
      data: { ...target, args: { path: 'evidence.txt' }, toolName: 'workspace.writeFile' },
      name: TOOL_APPROVAL_DATA_NAME,
      type: 'data',
    });
    store.publish(update);
    const appendRoot = vi.fn();
    render(
      <TooltipProvider>
        <DelegatedConversationPanel
          label="Cedar"
          onNew={createDelegatedDecisionDispatcher(update.identity, appendRoot)}
          store={store}
          threadId="child"
        />
      </TooltipProvider>
    );
    await user.click(await screen.findByRole('button', { name: /approve workspace.writefile/i }));
    expect(appendRoot).toHaveBeenCalledTimes(1);
    expect(appendRoot.mock.calls[0]?.[0]).toMatchObject({
      runConfig: { custom: { [TOOL_APPROVAL_RUN_CONFIG_KEY]: { ...target, action: 'approve' } } },
    });
    expect(appendRoot.mock.calls[0]?.[0]).not.toHaveProperty('parentId');
  });

  it('uses the shared transcript for live snapshots and retains output after the view closes', async () => {
    const store = createDelegatedConversationStore('root');
    const onNew = vi.fn(async () => undefined);
    store.publish(delegatedUpdate('child', 'initial', 'First child output.'));
    const view = () => (
      <TooltipProvider>
        <DelegatedConversationPanel label="Cedar" onNew={onNew} store={store} threadId="child" />
      </TooltipProvider>
    );
    const mounted = render(view());
    expect(await screen.findByText('Inspect the workspace')).toBeVisible();
    expect(await screen.findByText('First child output.')).toBeVisible();
    await act(async () => {
      store.publish(delegatedUpdate('child', 'initial', 'Complete child output.'));
    });
    expect(await screen.findByText('Complete child output.')).toBeVisible();
    expect(screen.queryByText('First child output.')).not.toBeInTheDocument();
    expect(onNew).not.toHaveBeenCalled();
    mounted.unmount();
    store.publish(delegatedUpdate('child', 'initial', 'Finished while closed.'));
    render(view());
    expect(await screen.findByText('Finished while closed.')).toBeVisible();
    expect(onNew).not.toHaveBeenCalled();
  });
});
