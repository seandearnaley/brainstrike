import '@testing-library/jest-dom/vitest';
// Must evaluate before anything that loads React DOM (see its header).
import './committed-assistant-browser-support';
import { TooltipProvider } from '@brainstrike/ui';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { CommittedAssistantConversation } from '../committed-assistant-conversation';
import type { CommittedAssistantLogRow } from '../committed-assistant-log-projection';
import {
  type CommittedAssistantLogSourceSnapshot,
  CommittedAssistantLogStore,
} from '../committed-assistant-log-store';
import type {
  CommittedAssistantCommands,
  CommittedAssistantStore,
} from '../committed-assistant-store';
import {
  committedRows,
  pendingApprovalLength,
  press,
  RecordedCommittedSource,
  recordedBaseline,
  recordedStore,
  recordedToolName,
  rejectingNew,
  respondedLength,
  STALE_INTERACTION,
  settleAnimations,
  tabTo,
} from './committed-assistant-browser-support';
// Actual canonical HostCore + SQLite + public SDK captures, byte-identical
// copies of apps/desktop/src/__tests__/fixtures/committed-host-{plan,question}.json.
import planRecording from './fixtures/committed-host-plan.json';
import questionRecording from './fixtures/committed-host-question.json';
import '@brainstrike/ui/globals.css';
import '../overrides.css';
import './assistant-conversation-panel.browser.css';

/**
 * BST-1929 corrections 2 and 3 pinned to their exact focus targets: a pending
 * decision keeps keyboard focus on the pressed control (aria-disabled, guarded
 * against a repeat), the committed response hands focus to that call's card,
 * and dismissing a command error returns focus to the composer.
 */

const LABEL = 'Committed conversation';

function Surface({
  store,
  actions,
}: {
  readonly store: CommittedAssistantStore;
  readonly actions: CommittedAssistantCommands;
}): ReactElement {
  return (
    <TooltipProvider>
      <div style={{ height: 620, width: 900 }}>
        <CommittedAssistantConversation commands={actions} label={LABEL} store={store} />
      </div>
    </TooltipProvider>
  );
}

/** Passive publication of a recorded committed prefix; the production store folds it. */
class RecordedPrefix {
  private length = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly rows: readonly CommittedAssistantLogRow[]) {}

  readonly getSnapshot = (): CommittedAssistantLogSourceSnapshot => ({
    connected: true,
    error: undefined,
    rows: this.rows.slice(0, this.length),
  });

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  publish(length: number): void {
    this.length = length;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function recordedInteraction(rows: readonly CommittedAssistantLogRow[]) {
  const started = rows.find(({ event }) => event['type'] === 'run.started');
  const runId = started?.event['runId'];
  const pending = rows.findIndex(
    ({ event }) => event['type'] === 'command.accepted' && event['method'] === 'interaction/resume'
  );
  const responded = rows.findIndex(({ event }) => event['type'] === 'interaction.responded');
  if (!(started && typeof runId === 'string' && pending > 0 && responded > pending)) {
    throw new Error('The recorded interaction is incomplete.');
  }
  const source = new RecordedPrefix(rows);
  source.publish(pending);
  const store = new CommittedAssistantLogStore({
    // Test-owned resolver, as in the projection suite: no production alias.
    identifyRun: () => ({
      assistantMessageId: runId,
      createdAt: new Date('2026-10-06T08:16:33.838Z'),
      parentMessageId: null,
    }),
    source,
    threadId: started.threadId,
  });
  onTestFinished(() => store.dispose());
  return { publishResponse: () => source.publish(responded + 1), store };
}

function conversation() {
  const region = screen.getByRole('region', { name: LABEL });
  return { region, ui: within(region) };
}

function cardOf(element: HTMLElement): HTMLElement {
  const card = element.closest<HTMLElement>('[data-testid="tool-fallback"]');
  if (!card) {
    throw new Error('The decision is not inside the shipped tool card.');
  }
  return card;
}

describe('pending committed decisions', () => {
  test('a pending approval keeps the pressed control focused, refuses a repeat, then hands focus to its card', async () => {
    const { baseline } = await recordedBaseline();
    const source = new RecordedCommittedSource();
    source.publishPrefix(pendingApprovalLength);
    const store = await recordedStore(source, baseline);
    onTestFinished(() => store.dispose());
    const admitted = Promise.withResolvers<void>();
    const respond = vi.fn(() => admitted.promise);
    render(
      <Surface
        actions={{ onNew: rejectingNew(), onRespondToToolApproval: respond }}
        store={store}
      />
    );
    const { region, ui } = conversation();
    const decision = await ui.findByRole('group', { name: `Tool approval ${recordedToolName}` });
    await settleAnimations(region);
    const card = cardOf(decision);
    const approve = within(decision).getByRole('button', { name: `Approve ${recordedToolName}` });
    const decline = within(decision).getByRole('button', { name: `Decline ${recordedToolName}` });

    await press(approve);
    expect(respond).toHaveBeenCalledOnce();
    expect(approve).toHaveFocus();
    expect(approve).toHaveAttribute('aria-disabled', 'true');
    expect(decline).toHaveAttribute('aria-disabled', 'true');
    // The guard, not a disabled attribute, refuses the repeat.
    await act(async () => {
      await userEvent.keyboard('{Enter}');
    });
    expect(respond).toHaveBeenCalledOnce();
    expect(approve).toHaveFocus();

    await act(async () => {
      admitted.resolve();
      await admitted.promise;
    });
    await act(async () => source.publishPrefix(respondedLength));
    await waitFor(() => expect(decision).not.toBeInTheDocument());
    expect(card).toHaveFocus();
    expect(card).toHaveAttribute('tabindex', '-1');
    expect(respond).toHaveBeenCalledOnce();
  });

  test('a refused approval clears the pending state so the same control retries', async () => {
    const { baseline } = await recordedBaseline();
    const source = new RecordedCommittedSource();
    source.publishPrefix(pendingApprovalLength);
    const store = await recordedStore(source, baseline);
    onTestFinished(() => store.dispose());
    const respond = vi
      .fn<NonNullable<CommittedAssistantCommands['onRespondToToolApproval']>>()
      .mockRejectedValueOnce(new Error(STALE_INTERACTION))
      .mockResolvedValue(undefined);
    render(
      <Surface
        actions={{ onNew: rejectingNew(), onRespondToToolApproval: respond }}
        store={store}
      />
    );
    const { region, ui } = conversation();
    const decision = await ui.findByRole('group', { name: `Tool approval ${recordedToolName}` });
    await settleAnimations(region);
    const approve = within(decision).getByRole('button', { name: `Approve ${recordedToolName}` });

    await press(approve);
    expect(await within(decision).findByRole('alert')).toHaveTextContent(STALE_INTERACTION);
    expect(approve).not.toHaveAttribute('aria-disabled');
    expect(approve).toHaveFocus();
    await act(async () => {
      await userEvent.keyboard('{Enter}');
    });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
  });

  test.each([
    {
      group: 'Question for you',
      kind: 'question',
      rows: questionRecording as readonly CommittedAssistantLogRow[],
      submit: 'Send answer',
    },
    {
      group: 'Plan decision',
      kind: 'plan',
      rows: planRecording as readonly CommittedAssistantLogRow[],
      submit: 'Reject plan',
    },
  ])(
    'a recorded $kind keeps the pressed control focused while pending, then hands focus to its card',
    async ({ group, kind, rows, submit }) => {
      const { publishResponse, store } = recordedInteraction(rows);
      const admitted = Promise.withResolvers<void>();
      const respond = vi.fn(() => admitted.promise);
      render(
        <Surface
          actions={{ onNew: rejectingNew(), onRespondToToolApproval: respond }}
          store={store}
        />
      );
      const { region, ui } = conversation();
      const form = await ui.findByRole('group', { name: group });
      await settleAnimations(region);
      const card = cardOf(form);
      if (kind === 'question') {
        await act(async () => {
          await userEvent.click(within(form).getByRole('checkbox', { name: 'Local' }));
        });
      }
      const button = within(form).getByRole('button', { name: submit });

      await press(button);
      await waitFor(() => expect(respond).toHaveBeenCalledOnce());
      expect(button).toHaveFocus();
      expect(button).toHaveAttribute('aria-disabled', 'true');
      await act(async () => {
        await userEvent.keyboard('{Enter}');
      });
      expect(respond).toHaveBeenCalledOnce();

      await act(async () => {
        admitted.resolve();
        await admitted.promise;
      });
      await act(async () => publishResponse());
      await waitFor(() => expect(form).not.toBeInTheDocument());
      expect(card).toHaveFocus();
    }
  );
});

test('dismissing a command error by keyboard returns focus to the composer', async () => {
  const { baseline } = await recordedBaseline();
  const source = new RecordedCommittedSource();
  source.publishPrefix(committedRows.length);
  const store = await recordedStore(source, baseline);
  onTestFinished(() => store.dispose());
  render(<Surface actions={{ onNew: rejectingNew() }} store={store} />);
  const { region, ui } = conversation();
  await ui.findByText('Host run completed.');
  await settleAnimations(region);
  const input = ui.getByRole('textbox', { name: 'Message input' });
  await act(async () => {
    input.focus();
    await userEvent.keyboard('Report the result again{Enter}');
  });
  const host = region.parentElement;
  if (!host) {
    throw new Error('The committed conversation wrapper is missing.');
  }
  const alert = await within(host).findByRole('alert', { name: 'Agent command error' });
  const dismiss = within(alert).getByRole('button', { name: 'Dismiss' });
  await tabTo(dismiss, 'backward');
  await act(async () => {
    await userEvent.keyboard('{Enter}');
  });
  expect(within(host).queryByRole('alert', { name: 'Agent command error' })).toBeNull();
  expect(input).toHaveFocus();
});
