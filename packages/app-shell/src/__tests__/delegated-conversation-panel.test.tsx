// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {
  TOOL_APPROVAL_DATA_NAME,
  TOOL_APPROVAL_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-approval';
import { TooltipProvider } from '@brainstrike/ui';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DelegatedConversationPanel } from '../delegated-conversation-panel';
import { createDelegatedConversationStore } from '../delegated-conversation-store';
import { createDelegatedDecisionDispatcher } from '../delegated-decision-dispatcher';
import { delegatedUpdate } from './helpers/delegated-conversation-fixtures';

afterEach(cleanup);

describe('host-owned child panel', () => {
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
