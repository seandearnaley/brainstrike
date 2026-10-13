import { refusalError } from '@brainstrike/assistant-contract';
import '@testing-library/jest-dom/vitest';
// Must evaluate before anything that loads React DOM: it installs the React
// DevTools hook and Scheduler MessageChannel timing used by the render-cost suite.
import './committed-assistant-browser-support';
import { act, cleanup, getConfig, render, screen, waitFor, within } from '@testing-library/react';
import { Profiler, type ReactElement, version as reactVersion, useCallback } from 'react';
import { afterAll, beforeAll, describe, expect, onTestFinished, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import {
  type CommittedAssistantCommands,
  type CommittedAssistantSnapshot,
  type CommittedAssistantStore,
  selectCommittedAssistantMessage,
  selectCommittedAssistantTool,
} from '../committed-assistant-store';
import { ToolFallback } from '../tool-fallback';
import { ToolResultRendererProvider } from '../tool-result-renderer-context';
import { useCommittedAssistantSelector } from '../use-committed-assistant-runtime';
import type { ToolResultRenderer } from '../use-tool-result-renderers';
import {
  ATTRIBUTION_TRIALS,
  answerStepLength,
  CHILD_THREAD_ID,
  captureUncaught,
  committedRows,
  count,
  distanceFromBottom,
  focusPlacement,
  HOST_FAILURES,
  instrumentation,
  type Measurement,
  type MountTrial,
  measureRecordedTextPublications,
  messageRoots,
  pendingApprovalLength,
  press,
  RecordedCommittedSource,
  type RenderCounts,
  RUN_REFUSED,
  recordedBaseline,
  recordedInteractionId,
  recordedPrompt,
  recordedPromptId,
  recordedRunId,
  recordedStore,
  recordedToolCallId,
  recordedToolName,
  recordedToolResult,
  rejectingNew,
  report,
  respondedLength,
  STALE_INTERACTION,
  settleAnimations,
  settleFrames,
  TEXT_KINDS,
  TOOL_CARD_COMPONENTS,
  TRIALS,
  tabTo,
  useReducedMotion,
  useViewport,
  watchUnchanged,
  ZERO_COUNTS,
} from './committed-assistant-browser-support';
import { PublishedConversation } from './committed-assistant-test-support';
import { conversation, Surface } from './committed-conversation-surface';
import { publishLiveText, TEXT_PUBLICATIONS } from './committed-live-text-support';
import '@brainstrike/ui/globals.css';
import '../overrides.css';
import './assistant-conversation-panel.browser.css';

/**
 * BST-1929 / BST-1931: the shipped committed conversation in real Chromium,
 * driven only by the recorded HostCore run and the native child capture. A
 * passive source publishes committed prefixes and the owner's connection view;
 * the production projection folds them, and every command port is a test
 * double that is either refused, rejected, or merely admitted — never a host
 * success that writes transcript state.
 */

const APPROVE = `Approve ${recordedToolName}`;
const DECLINE = `Decline ${recordedToolName}`;
const COMPLETED_TEXT = 'Host run completed.';
const LAZY_RENDERER_TIMEOUT_MS = 10_000;
const UNAVAILABLE = 'The agent host is unavailable.';
const DISCONNECTED = 'Agent host disconnected. Reconnect to continue.';

describe('same-thread connection changes', () => {
  test.each([390, 900])(
    'disconnect, version/runtime/capability failures, reconnect and replacement-store replay keep the transcript, draft and focus at %ipx',
    async (width) => {
      await useViewport(width);
      const { baseline } = await recordedBaseline();
      const source = new RecordedCommittedSource();
      source.publishPrefix(pendingApprovalLength);
      const first = await recordedStore(source, baseline);
      const onNew = rejectingNew();
      const view = render(<Surface actions={{ onNew }} store={first} width={width} />);
      const surface = conversation();
      await surface.ui.findByText(recordedPrompt);
      await settleAnimations(surface.region);
      expect(surface.ui.getByRole('button', { name: APPROVE })).toBeVisible();
      const mountedRows = messageRoots(surface.viewport);
      expect([...mountedRows.keys()]).toEqual([baseline.headId, recordedPromptId, recordedRunId]);
      await act(async () => {
        await userEvent.click(surface.input);
        await userEvent.keyboard('Keep this draft');
      });
      let draft = 'Keep this draft';

      const expectRetained = (): void => {
        const current = conversation();
        expect(current.region).toBe(surface.region);
        expect(current.viewport).toBe(surface.viewport);
        for (const [id, row] of mountedRows) {
          expect(messageRoots(current.viewport).get(id)).toBe(row);
        }
        expect(current.input).toBe(surface.input);
        expect(surface.input).toHaveValue(draft);
        expect(surface.input).toHaveFocus();
        // Errors reserve their own height; the composer never leaves the pane.
        const pane = surface.root.getBoundingClientRect();
        const composer = current.ui.getByTestId('assistant-composer-shell').getBoundingClientRect();
        expect(composer.bottom).toBeLessThanOrEqual(pane.bottom + 1);
      };
      expectRetained();

      await act(async () => source.setConnection(false));
      const status = surface.host.getByText(DISCONNECTED);
      expect(status).toHaveAttribute('role', 'status');
      expect(status).toHaveAttribute('aria-live', 'polite');
      expect(status).toBeVisible();
      expect(surface.ui.getByText(UNAVAILABLE)).toBeVisible();
      expectRetained();

      for (const failure of HOST_FAILURES) {
        await act(async () => source.setConnection(false, failure.text));
        const alert = surface.host.getByRole('alert', { name: 'Agent host error' });
        expect(alert, failure.kind).toHaveTextContent(failure.text);
        expect(alert).toBeVisible();
        expect(surface.host.queryByText(DISCONNECTED)).toBeNull();
        expectRetained();
        // Focus is live, not merely reported: the reader keeps typing.
        await act(async () => {
          await userEvent.keyboard(` ${failure.kind}`);
        });
        draft = `${draft} ${failure.kind}`;
        expectRetained();
      }

      await act(async () => source.setConnection(true));
      expect(surface.host.queryByRole('alert', { name: 'Agent host error' })).toBeNull();
      expect(surface.host.queryByText(DISCONNECTED)).toBeNull();
      expect(surface.ui.queryByText(UNAVAILABLE)).toBeNull();
      expectRetained();

      // A fresh production store re-folds the same committed prefix from seq 1.
      const replacement = await recordedStore(source, baseline);
      view.rerender(<Surface actions={{ onNew }} store={replacement} width={width} />);
      first.dispose();
      onTestFinished(() => replacement.dispose());
      await settleFrames();
      expectRetained();
      // The replayed pending interaction is still the one the host is waiting on.
      expect(surface.ui.getByRole('button', { name: APPROVE })).toBeEnabled();

      // The next committed suffix appends to the retained rows.
      await act(async () => source.publishPrefix(committedRows.length));
      expect(await surface.ui.findByText(COMPLETED_TEXT)).toBeVisible();
      expectRetained();
      expect(onNew).not.toHaveBeenCalled();
    }
  );
});

const READER_PANEL_HEIGHT = 300;
/** A reading position needs real content above and below it. */
const MIN_READER_OVERFLOW_PX = 48;

async function mountReader(width: number) {
  const { baseline } = await recordedBaseline();
  const source = new RecordedCommittedSource();
  source.publishPrefix(answerStepLength);
  const store = await recordedStore(source, baseline);
  onTestFinished(() => store.dispose());
  const view = render(
    <Surface
      actions={{ onNew: rejectingNew() }}
      height={READER_PANEL_HEIGHT}
      store={store}
      width={width}
    />
  );
  const surface = conversation();
  await surface.ui.findByText(recordedPrompt);
  // Read the recorded arguments/result: a real keyboard expansion of the shipped card.
  const details = surface.ui.getByRole('button', { name: /expand details/ });
  await press(details);
  await waitFor(() => {
    expect(surface.viewport.scrollHeight - surface.viewport.clientHeight).toBeGreaterThanOrEqual(
      MIN_READER_OVERFLOW_PX
    );
    expect(distanceFromBottom(surface.viewport)).toBeLessThanOrEqual(1);
  });
  // Geometry baselines must not be read through the message/card entrance motion.
  await settleAnimations(surface.region);
  return { baseline, source, store, surface, view };
}

describe('reading position', () => {
  test.each(
    [390, 900].flatMap((width) => [false, true].map((reducedMotion) => ({ reducedMotion, width })))
  )(
    'committed text and reconnects never move a reader parked above the bottom; jump-to-latest re-pins ($width / reduced=$reducedMotion)',
    async ({ width, reducedMotion }) => {
      await useViewport(width);
      await useReducedMotion(reducedMotion);
      const { baseline, source, store, surface, view } = await mountReader(width);
      const { viewport, ui } = surface;
      expect(getComputedStyle(viewport).scrollBehavior).toBe(reducedMotion ? 'auto' : 'smooth');
      const jump = ui.getByRole('button', { name: 'Scroll to latest messages' });
      await waitFor(() => expect(jump).toBeDisabled());

      const readerTop = Math.floor((viewport.scrollHeight - viewport.clientHeight) / 2);
      act(() => {
        viewport.scrollTo({ behavior: 'instant', top: readerTop });
      });
      await waitFor(() => expect(jump).toBeEnabled());
      expect(viewport.scrollTop).toBe(readerTop);
      const bounds = viewport.getBoundingClientRect();
      const anchor = document.elementFromPoint(
        bounds.left + bounds.width / 2,
        bounds.top + viewport.clientHeight / 2
      );
      if (!(anchor instanceof HTMLElement && viewport.contains(anchor))) {
        throw new Error('No transcript content sits at the reading position.');
      }
      const anchorOffset = (): number =>
        anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      const readingOffset = anchorOffset();
      const expectReaderUndisturbed = async (step: string): Promise<void> => {
        await settleFrames();
        expect(anchor.isConnected, step).toBe(true);
        expect(Math.abs(anchorOffset() - readingOffset), step).toBeLessThanOrEqual(1);
        expect(distanceFromBottom(viewport), step).toBeGreaterThan(1);
        expect(jump, step).toBeEnabled();
      };

      const contentBefore = viewport.scrollHeight;
      for (const publication of TEXT_PUBLICATIONS) {
        await act(async () => publication.publish(source, store));
        await expectReaderUndisturbed(publication.label);
      }
      expect(ui.getByText(COMPLETED_TEXT)).toBeInTheDocument();
      // Non-vacuous: the committed text really grew the transcript below the reader.
      expect(viewport.scrollHeight).toBeGreaterThan(contentBefore);

      const topBeforeNotice = viewport.scrollTop;
      await act(async () => source.setConnection(false));
      await expectReaderUndisturbed('disconnect');
      // Non-vacuous: the unavailable notice was inserted ABOVE the reader, and
      // native anchoring (not an unchanged layout) is what held the text still.
      expect(ui.getByText(UNAVAILABLE)).toBeInTheDocument();
      expect(viewport.scrollTop).toBeGreaterThan(topBeforeNotice);
      for (const failure of HOST_FAILURES) {
        await act(async () => source.setConnection(false, failure.text));
        await expectReaderUndisturbed(failure.kind);
      }
      await act(async () => source.setConnection(true));
      await expectReaderUndisturbed('reconnect');
      const replacement = await recordedStore(source, baseline);
      onTestFinished(() => replacement.dispose());
      view.rerender(
        <Surface
          actions={{ onNew: rejectingNew() }}
          height={READER_PANEL_HEIGHT}
          store={replacement}
          width={width}
        />
      );
      await expectReaderUndisturbed('replacement-store replay');

      await press(jump);
      await waitFor(
        () => {
          expect(distanceFromBottom(viewport)).toBeLessThanOrEqual(1);
          expect(jump).toBeDisabled();
        },
        // Smooth scrolling animates; reduced motion is instant.
        { timeout: Math.max(5000, getConfig().asyncUtilTimeout) }
      );
      expect(ui.getByText(COMPLETED_TEXT)).toBeVisible();
    }
  );

  test.each(
    [390, 900].flatMap((width) => [false, true].map((reducedMotion) => ({ reducedMotion, width })))
  )(
    'a pinned reader follows every committed text publication and reconnect ($width / reduced=$reducedMotion)',
    async ({ width, reducedMotion }) => {
      await useViewport(width);
      await useReducedMotion(reducedMotion);
      const { source, store, surface } = await mountReader(width);
      const { viewport, ui } = surface;
      const jump = ui.getByRole('button', { name: 'Scroll to latest messages' });
      const expectPinned = async (step: string): Promise<void> => {
        await settleFrames();
        expect(distanceFromBottom(viewport), step).toBeLessThanOrEqual(1);
        expect(viewport.scrollHeight, step).toBeGreaterThan(viewport.clientHeight);
        expect(jump, step).toBeDisabled();
        expect(viewport.closest('.bs-thread-scroll-region'), step).toHaveAttribute(
          'data-pinned',
          'true'
        );
      };
      await expectPinned('opened');
      const contentBefore = viewport.scrollHeight;
      for (const publication of TEXT_PUBLICATIONS) {
        const before = viewport.scrollHeight;
        await act(async () => publication.publish(source, store));
        await expectPinned(
          `${publication.label} (scrollHeight ${before} → ${viewport.scrollHeight})`
        );
      }
      // Non-vacuous: following meant moving, because the committed text grew.
      expect(viewport.scrollHeight).toBeGreaterThan(contentBefore);
      await act(async () => source.setConnection(false, HOST_FAILURES[0].text));
      await expectPinned('version failure');
      await act(async () => source.setConnection(true));
      await expectPinned('reconnect');
    }
  );
});

async function mountPendingApproval(
  respond: CommittedAssistantCommands['onRespondToToolApproval'],
  extra: Partial<CommittedAssistantCommands> = {}
) {
  const { baseline, saved } = await recordedBaseline();
  const source = new RecordedCommittedSource();
  source.publishPrefix(pendingApprovalLength);
  const store = await recordedStore(source, baseline);
  onTestFinished(() => store.dispose());
  const onNew = rejectingNew();
  render(<Surface actions={{ onNew, onRespondToToolApproval: respond, ...extra }} store={store} />);
  const surface = conversation();
  await surface.ui.findByText(recordedPrompt);
  await settleAnimations(surface.region);
  const card = surface.ui.getByRole('group', { name: `Tool approval ${recordedToolName}` });
  const toolCard = card.closest<HTMLElement>('[data-testid="tool-fallback"]');
  if (!toolCard) {
    throw new Error('The approval controls are not inside the shipped tool card.');
  }
  return {
    approve: within(card).getByRole('button', { name: APPROVE }),
    card,
    decline: within(card).getByRole('button', { name: DECLINE }),
    onNew,
    saved,
    source,
    store,
    surface,
    toolCard,
  };
}

const EXACT_APPROVAL = {
  approvalId: recordedInteractionId,
  approved: true,
  optionId: 'approve',
};

describe('keyboard approval and errors', () => {
  test('keyboard approval dispatches the exact committed interaction once; only the committed response suffix settles the card', async () => {
    const admitted = Promise.withResolvers<void>();
    const respond = vi.fn(() => admitted.promise);
    const { approve, card, decline, source, store, surface } = await mountPendingApproval(respond);
    expect(approve).toBeVisible();
    expect(decline).toBeVisible();
    // Keyboard only: from the composer, reverse Tab order reaches the decision.
    await act(async () => surface.input.focus());
    await tabTo(approve, 'backward');
    await act(async () => {
      await userEvent.keyboard('{Enter}');
    });
    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(EXACT_APPROVAL);
    const committed = store.getSnapshot().repository;
    // Admitted but not committed: the decision stays visibly pending.
    await act(async () => {
      admitted.resolve();
      await admitted.promise;
    });
    await settleFrames();
    expect(store.getSnapshot().repository).toBe(committed);
    expect(card).toBeInTheDocument();
    // Pending controls keep focus: aria-disabled, never the focus-dropping `disabled`.
    for (const name of [APPROVE, DECLINE]) {
      expect(within(card).getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true');
    }

    await act(async () => source.publishPrefix(respondedLength));
    await waitFor(() => expect(card).not.toBeInTheDocument());
    expect(surface.ui.queryByRole('button', { name: APPROVE })).toBeNull();
    await act(async () => source.publishPrefix(committedRows.length));
    const done = await surface.ui.findByRole('button', {
      name: new RegExp(`^Used ${recordedToolName}`),
    });
    // The settled row re-enters with the shipped reveal motion.
    await waitFor(() => expect(done).toBeVisible());
    expect(respond).toHaveBeenCalledOnce();
  });

  test('a pending committed approval card shows the shipped waiting-for-approval status', async () => {
    const { toolCard } = await mountPendingApproval(vi.fn(async () => undefined));
    const states = within(toolCard)
      .getAllByRole('img')
      .map((glyph) => glyph.getAttribute('aria-label'));
    // tool-fallback.tsx: a live approval pause is `waiting` and reads this label.
    expect(states).toContain('Waiting for approval');
  });

  test('keyboard approval keeps focus inside the conversation while pending and after the committed response', async () => {
    const admitted = Promise.withResolvers<void>();
    const { approve, source, surface } = await mountPendingApproval(vi.fn(() => admitted.promise));
    await act(async () => surface.input.focus());
    await tabTo(approve, 'backward');
    await act(async () => {
      await userEvent.keyboard('{Enter}');
    });
    expect
      .soft(focusPlacement(surface.root), 'after keyboard dispatch')
      .toBe('inside the conversation');
    await act(async () => {
      admitted.resolve();
      await admitted.promise;
    });
    await act(async () => source.publishPrefix(respondedLength));
    await waitFor(() => expect(surface.ui.queryByRole('button', { name: APPROVE })).toBeNull());
    expect
      .soft(focusPlacement(surface.root), 'after the committed response')
      .toBe('inside the conversation');
  });

  test('a refused decision is announced in its card, which stays pending for an exact retry', async () => {
    const respond = vi.fn(async () => {
      throw refusalError('conflict', 'interaction.stale', STALE_INTERACTION);
    });
    const { approve, card, store, surface } = await mountPendingApproval(respond);
    const committed = store.getSnapshot().repository;
    await act(async () => surface.input.focus());
    await tabTo(approve, 'backward');
    await act(async () => {
      await userEvent.keyboard('{Enter}');
    });
    const alert = await within(card).findByRole('alert');
    expect(alert).toHaveTextContent(STALE_INTERACTION);
    expect(alert).toBeVisible();
    expect(within(card).getByRole('button', { name: APPROVE })).toBeEnabled();
    expect(store.getSnapshot().repository).toBe(committed);
    await act(async () => surface.input.focus());
    await tabTo(approve, 'backward');
    await act(async () => {
      await userEvent.keyboard('{Enter}');
    });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
    expect(respond.mock.calls).toEqual([[EXACT_APPROVAL], [EXACT_APPROVAL]]);
    expect(card).toBeInTheDocument();
  });

  async function refuseSend() {
    const onNew = rejectingNew();
    const { surface } = await mountCompleted({ onNew });
    const rows = [...messageRoots(surface.viewport).keys()];
    await act(async () => {
      surface.input.focus();
      await userEvent.keyboard('Report the result again{Enter}');
    });
    const alert = await surface.host.findByRole('alert', { name: 'Agent command error' });
    return { alert, onNew, rows, surface };
  }

  test('a refused send is announced by name, restores its unsent draft, and is dismissed by keyboard', async () => {
    const { alert, onNew, rows, surface } = await refuseSend();
    expect(onNew).toHaveBeenCalledOnce();
    expect(alert).toHaveTextContent(RUN_REFUSED);
    expect(alert).toBeVisible();
    await waitFor(() => expect(surface.input).toHaveValue('Report the result again'));
    // No optimistic row: only committed rows render.
    expect([...messageRoots(surface.viewport).keys()]).toEqual(rows);
    const dismiss = within(alert).getByRole('button', { name: 'Dismiss' });
    await tabTo(dismiss, 'backward');
    await act(async () => {
      await userEvent.keyboard('{Enter}');
    });
    expect(surface.host.queryByRole('alert', { name: 'Agent command error' })).toBeNull();
    expect(surface.input).toHaveValue('Report the result again');
  });

  test('keyboard dismissal of a command error keeps focus inside the conversation', async () => {
    const { alert, surface } = await refuseSend();
    const dismiss = within(alert).getByRole('button', { name: 'Dismiss' });
    await tabTo(dismiss, 'backward');
    await act(async () => {
      await userEvent.keyboard('{Enter}');
    });
    expect(surface.host.queryByRole('alert', { name: 'Agent command error' })).toBeNull();
    expect(focusPlacement(surface.root)).toBe('inside the conversation');
  });
});

async function mountCompleted(actions: CommittedAssistantCommands, branchedFromSaved = false) {
  const { baseline, saved } = await recordedBaseline();
  const source = new RecordedCommittedSource();
  source.publishPrefix(committedRows.length);
  // Branched: the recorded prompt is a committed sibling of the saved answer.
  const store = await recordedStore(source, baseline, branchedFromSaved ? null : baseline.headId);
  onTestFinished(() => store.dispose());
  const view = render(<Surface actions={actions} store={store} />);
  const surface = conversation();
  await surface.ui.findByText(COMPLETED_TEXT);
  await settleAnimations(surface.region);
  return { saved, source, store, surface, view };
}

describe('refused dispatch and unavailable capabilities', () => {
  test('retained approval and Stop callbacks refuse dispatch after a disconnect; reconnect answers exactly once', async () => {
    const respond = vi.fn(async () => undefined);
    const onCancel = vi.fn(async () => undefined);
    const { approve, card, source, store, surface } = await mountPendingApproval(respond, {
      onCancel,
    });
    const stop = surface.ui.getByRole('button', { name: 'Stop' });
    expect(stop).toBeEnabled();
    const committed = store.getSnapshot().repository;

    await act(async () => source.setConnection(false));
    await act(async () => surface.input.focus());
    await tabTo(approve, 'backward');
    await act(async () => {
      await userEvent.keyboard('{Enter}');
    });
    expect(await within(card).findByRole('alert')).toHaveTextContent(UNAVAILABLE);
    expect(respond).not.toHaveBeenCalled();
    expect(within(card).getByRole('button', { name: APPROVE })).toBeEnabled();
    await press(stop);
    const commandAlert = await surface.host.findByRole('alert', { name: 'Agent command error' });
    expect(commandAlert).toHaveTextContent(UNAVAILABLE);
    expect(onCancel).not.toHaveBeenCalled();
    expect(store.getSnapshot().repository).toBe(committed);

    await act(async () => source.setConnection(true));
    await act(async () => surface.input.focus());
    await tabTo(approve, 'backward');
    await act(async () => {
      await userEvent.keyboard('{Enter}');
    });
    await waitFor(() => expect(respond).toHaveBeenCalledOnce());
    expect(respond).toHaveBeenCalledWith(EXACT_APPROVAL);
    await act(async () => source.publishPrefix(respondedLength));
    await waitFor(() => expect(card).not.toBeInTheDocument());
    expect(respond).toHaveBeenCalledOnce();
  });

  test('a retained send refuses dispatch while disconnected and is admitted once after reconnect, without an optimistic row', async () => {
    const onNew = vi.fn(async () => undefined);
    const { source, surface } = await mountCompleted({ onNew });
    const rows = [...messageRoots(surface.viewport).keys()];
    await act(async () => {
      surface.input.focus();
      await userEvent.keyboard('Follow up on the fixture');
    });
    const send = surface.ui.getByRole('button', { name: 'Send' });
    expect(send).toBeEnabled();
    await act(async () => source.setConnection(false));
    expect(send).toBeDisabled();
    await act(async () => {
      await userEvent.keyboard('{Enter}');
    });
    expect(onNew).not.toHaveBeenCalled();
    expect(surface.input).toHaveValue('Follow up on the fixture');
    expect(surface.input).toHaveFocus();

    await act(async () => source.setConnection(true));
    expect(send).toBeEnabled();
    await act(async () => {
      await userEvent.keyboard('{Enter}');
    });
    await waitFor(() => expect(onNew).toHaveBeenCalledOnce());
    expect(onNew).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [{ text: 'Follow up on the fixture', type: 'text' }],
        role: 'user',
      })
    );
    await settleFrames();
    // Admission is not a committed row: the transcript waits for the host.
    expect([...messageRoots(surface.viewport).keys()]).toEqual(rows);
  });

  test('unsupported edit and regenerate stay absent from the installed action bars; supplied ports show them and a disconnect refuses them', async () => {
    const onNew = rejectingNew();
    const { source, store, surface, view } = await mountCompleted({ onNew });
    const rows = messageRoots(surface.viewport);
    const userRow = rows.get(recordedPromptId);
    const answerRow = rows.get(recordedRunId);
    if (!(userRow && answerRow)) {
      throw new Error('Missing recorded prompt or answer row.');
    }
    await act(async () => {
      await userEvent.hover(userRow);
    });
    expect(await within(userRow).findByRole('button', { name: 'Copy message' })).toBeVisible();
    expect(within(userRow).queryByRole('button', { name: 'Edit message' })).toBeNull();
    await act(async () => {
      await userEvent.hover(answerRow);
    });
    expect(await within(answerRow).findByRole('button', { name: 'Copy message' })).toBeVisible();
    expect(within(answerRow).queryByRole('button', { name: 'Regenerate response' })).toBeNull();

    // Non-vacuous: the same installed controls appear once the owner supplies ports.
    const onEdit = vi.fn(async () => undefined);
    const onReload = vi.fn(async () => undefined);
    view.rerender(<Surface actions={{ onEdit, onNew, onReload }} store={store} />);
    await act(async () => {
      await userEvent.hover(userRow);
    });
    expect(await within(userRow).findByRole('button', { name: 'Edit message' })).toBeVisible();
    await act(async () => {
      await userEvent.hover(answerRow);
    });
    const regenerate = await within(answerRow).findByRole('button', {
      name: 'Regenerate response',
    });
    await act(async () => source.setConnection(false));
    await press(regenerate);
    const alert = await surface.host.findByRole('alert', { name: 'Agent command error' });
    expect(alert).toHaveTextContent(UNAVAILABLE);
    expect(onReload).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
  });

  test.each([
    { case: 'no branch port was supplied', withdrawn: false },
    { case: 'the branch port is withdrawn while disconnected', withdrawn: true },
  ])(
    'installed branch controls stay unavailable when $case',
    async ({ case: reason, withdrawn }) => {
      const uncaught = captureUncaught();
      const setMessages = vi.fn();
      const { saved, source, store, surface } = await mountCompleted(
        { onNew: rejectingNew(), ...(withdrawn ? { setMessages } : {}) },
        true
      );
      const committed = store.getSnapshot().repository;
      const controls = () =>
        surface.ui.queryAllByRole('button', { name: /^(Previous|Next) branch$/ });
      if (withdrawn) {
        expect(controls()).toHaveLength(2); // Non-vacuous: offered while the port is supplied.
        await act(async () => source.setConnection(false));
      }
      // Capability-gated (ADR-0008): omitted like unsupported Edit/Regenerate, never disabled.
      expect.soft(controls(), reason).toEqual([]);
      await settleFrames();
      expect(setMessages).not.toHaveBeenCalled();
      expect(surface.ui.getByText(recordedPrompt)).toBeVisible();
      const savedText = saved.content.find((part) => part.type === 'text')?.text ?? '';
      expect(surface.ui.queryByText(savedText)).toBeNull();
      expect(store.getSnapshot().repository).toBe(committed);
      expect(uncaught, 'activating the installed control').toEqual([]);
    }
  );

  test('a rejected branch command restores the canonical branch and announces the rejection', async () => {
    const uncaught = captureUncaught();
    const rejection = 'Branch command rejected';
    const setMessages = vi.fn(() => {
      throw refusalError('conflict', 'branch.rejected', rejection);
    });
    const { saved, store, surface } = await mountCompleted(
      { onNew: rejectingNew(), setMessages },
      true
    );
    const committed = store.getSnapshot().repository;
    const previous = surface.ui.getByRole('button', { name: 'Previous branch' });
    expect(previous).toBeEnabled();
    await press(previous);
    await settleFrames();
    expect(setMessages).toHaveBeenCalledOnce();
    expect(setMessages).toHaveBeenCalledWith([saved]);
    const alert = await surface.host.findByRole('alert', { name: 'Agent command error' });
    expect(alert).toHaveTextContent(rejection);
    // The vendor moved its local head before the port; the fold is restored.
    expect(surface.ui.getByText(recordedPrompt)).toBeVisible();
    expect(surface.ui.getByText(COMPLETED_TEXT)).toBeVisible();
    expect(store.getSnapshot().repository).toBe(committed);
    expect(uncaught, 'activating the installed control').toEqual([]);
  });
});

function CountedSelector({
  store,
  select,
  onRender,
}: {
  readonly store: CommittedAssistantStore;
  readonly select: (snapshot: CommittedAssistantSnapshot) => unknown;
  readonly onRender: () => void;
}): null {
  useCommittedAssistantSelector(store, select);
  onRender();
  return null;
}

/** One shipped-selector subscriber per card/row, as BST-1929's "selector per card". */
function SelectorProbes({
  counts,
  savedId,
  store,
}: {
  readonly counts: RenderCounts;
  readonly savedId: string;
  readonly store: CommittedAssistantStore;
}): ReactElement {
  const saved = useCallback(
    (snapshot: CommittedAssistantSnapshot) => selectCommittedAssistantMessage(snapshot, savedId),
    [savedId]
  );
  return (
    <>
      <CountedSelector onRender={() => count(counts, 'saved')} select={saved} store={store} />
      <CountedSelector
        onRender={() => count(counts, 'prompt')}
        select={selectPrompt}
        store={store}
      />
      <CountedSelector onRender={() => count(counts, 'tool')} select={selectTool} store={store} />
      <CountedSelector
        onRender={() => count(counts, 'approval')}
        select={selectApproval}
        store={store}
      />
    </>
  );
}

const selectPrompt = (snapshot: CommittedAssistantSnapshot) =>
  selectCommittedAssistantMessage(snapshot, recordedPromptId);
const selectTool = (snapshot: CommittedAssistantSnapshot) =>
  selectCommittedAssistantTool(snapshot, recordedRunId, recordedToolCallId);
const selectApproval = (snapshot: CommittedAssistantSnapshot) => selectTool(snapshot)?.approval;

describe('render cost', () => {
  test('answering the recorded approval re-renders only that card and mutates no unrelated row', async () => {
    const respond = vi.fn(async () => undefined);
    const { baseline, saved } = await recordedBaseline();
    const source = new RecordedCommittedSource();
    source.publishPrefix(pendingApprovalLength);
    const store = await recordedStore(source, baseline);
    onTestFinished(() => store.dispose());
    const counts: RenderCounts = { approval: 0, prompt: 0, saved: 0, tool: 0 };
    render(
      <>
        <SelectorProbes counts={counts} savedId={saved.id} store={store} />
        <Surface
          actions={{ onNew: rejectingNew(), onRespondToToolApproval: respond }}
          store={store}
        />
      </>
    );
    const surface = conversation();
    await surface.ui.findByText(recordedPrompt);
    await settleAnimations(surface.region);
    const rows = messageRoots(surface.viewport);
    const savedRow = rows.get(saved.id);
    const promptRow = rows.get(recordedPromptId);
    if (!(savedRow && promptRow)) {
      throw new Error('Missing unrelated committed rows.');
    }
    const unrelated = watchUnchanged({
      composer: surface.ui.getByTestId('assistant-composer-shell'),
      prompt: promptRow,
      saved: savedRow,
    });
    onTestFinished(unrelated.stop);
    const card = surface.ui.getByRole('group', { name: `Tool approval ${recordedToolName}` });
    const mounted = { ...counts };
    await press(within(card).getByRole('button', { name: APPROVE }));
    await waitFor(() => expect(respond).toHaveBeenCalledOnce());
    await settleFrames();
    const dispatched = { ...counts };
    instrumentation.reset();
    instrumentation.setRecording(true, true);
    await act(async () => source.publishPrefix(respondedLength));
    await waitFor(() => expect(card).not.toBeInTheDocument());
    await settleFrames();
    instrumentation.setRecording(false);
    const rendered = instrumentation.rendered();
    // React DevTools did-render rule: no component of an unrelated row rendered.
    expect(rendered.get(saved.id)).toBeUndefined();
    expect(rendered.get(recordedPromptId)).toBeUndefined();
    expect(rendered.get(recordedRunId)?.get('ToolFallback')).toBeGreaterThan(0);
    expect({
      dispatchedWithoutCommit: dispatched,
      respondedSuffix: {
        approval: counts.approval - dispatched.approval,
        prompt: counts.prompt - dispatched.prompt,
        saved: counts.saved - dispatched.saved,
        tool: counts.tool - dispatched.tool,
      },
    }).toEqual({
      // Dispatch alone renders no selector: nothing settles optimistically.
      dispatchedWithoutCommit: mounted,
      respondedSuffix: { approval: 1, prompt: 0, saved: 0, tool: 1 },
    });
    expect(unrelated.read()).toEqual([]);
  });
});

/**
 * A ceiling, not an expected duration: two async-utility budgets per trial (it
 * scales with TEST_TIMEOUT_MULTIPLIER).
 */
const MEASUREMENT_TIMEOUT_MS = (TRIALS + ATTRIBUTION_TRIALS) * 2 * getConfig().asyncUtilTimeout;
/** One measured trial: the root over the recorded store beside an independent child. */
const mountMeasuredTrial: MountTrial = async ({ baseline, firstChild, saved }) => {
  const source = new RecordedCommittedSource();
  source.publishPrefix(answerStepLength);
  const store = await recordedStore(source, baseline);
  const childStore = new PublishedConversation(CHILD_THREAD_ID, [firstChild]);
  const counts: RenderCounts = { ...ZERO_COUNTS };
  const views = { child: 0, root: 0, toolCard: 0 };
  const renderer: ToolResultRenderer = {
    Component: (props) => {
      views.toolCard += 1;
      return <ToolFallback {...props} />;
    },
    kind: 'committed-browser-counted-tool-card',
    matches: (result) => result === recordedToolResult,
  };
  const view = render(
    <ToolResultRendererProvider renderers={[renderer]}>
      <SelectorProbes counts={counts} savedId={saved.id} store={store} />
      <Profiler id="root" onRender={() => count(views, 'root')}>
        <Surface actions={{ onNew: rejectingNew() }} height={420} label="Root" store={store} />
      </Profiler>
      <Profiler id="child" onRender={() => count(views, 'child')}>
        <Surface
          actions={{ onNew: rejectingNew() }}
          height={320}
          label="Child"
          store={childStore}
        />
      </Profiler>
    </ToolResultRendererProvider>
  );
  const root = conversation('Root');
  await root.ui.findByText(recordedPrompt);
  await waitFor(() => expect(views.toolCard).toBeGreaterThan(0));
  await settleAnimations(document.body);
  const rows = messageRoots(root.viewport);
  const answer = rows.get(recordedRunId);
  const savedRow = rows.get(saved.id);
  const promptRow = rows.get(recordedPromptId);
  if (!(answer && savedRow && promptRow)) {
    throw new Error('Missing a recorded committed row.');
  }
  return {
    answer,
    composer: root.ui.getByTestId('assistant-composer-shell'),
    counts,
    promptRow,
    publishChild: (message) => childStore.replaceMessage(message),
    publishText: (kind) => publishLiveText(store, kind),
    savedRow,
    toolCard: root.ui.getByTestId('tool-fallback'),
    unmount: () => {
      // Trials share beforeAll: per-test cleanup runs only after all 45 mounts.
      // Release RTL's container/root registry between independent measurements.
      cleanup();
      store.dispose();
      expect(
        view.container,
        'each trial releases its Testing Library container'
      ).not.toBeInTheDocument();
    },
    views,
  };
};

async function warmUp(): Promise<void> {
  // Unmeasured: resolve the lazily loaded markdown renderer once, so samples
  // measure publication rendering rather than module loading.
  const { baseline } = await recordedBaseline();
  const source = new RecordedCommittedSource();
  source.publishPrefix(committedRows.length);
  const store = await recordedStore(source, baseline);
  const warm = render(<Surface actions={{ onNew: rejectingNew() }} store={store} />);
  // The first load of the lazy renderer chunk can outlast the 1 s default on a
  // loaded machine (4 of 20 runs at load 40-56 skipped the whole describe).
  await screen.findByText(COMPLETED_TEXT, undefined, { timeout: LAZY_RENDERER_TIMEOUT_MS });
  cleanup();
  store.dispose();
  expect(warm.container, 'warm-up releases its Testing Library container').not.toBeInTheDocument();
}

describe('recorded text publication cost (BST-1929 spike s-ui budget)', () => {
  let measurement: Measurement | undefined;
  let previousViewport: { readonly height: number; readonly width: number } | undefined;

  beforeAll(async () => {
    previousViewport = { height: window.innerHeight, width: window.innerWidth };
    await page.viewport(900, 800);
    await warmUp();
    measurement = await measureRecordedTextPublications(mountMeasuredTrial, COMPLETED_TEXT);
    const reactBuild = '_store' in <div /> ? 'development' : 'production';
    console.info(
      'COMMITTED_UI_MEASUREMENT',
      JSON.stringify(report(measurement, `${reactVersion} ${reactBuild}`))
    );
  }, MEASUREMENT_TIMEOUT_MS);

  afterAll(async () => {
    if (previousViewport) {
      await page.viewport(previousViewport.width, previousViewport.height);
    }
  });

  const measured = (): Measurement => {
    if (!measurement) {
      throw new Error('The recorded publication measurement did not run.');
    }
    return measurement;
  };

  test('the long-task observer reports a known 80 ms task (positive control)', () => {
    expect(measured().longTaskControl.length).toBeGreaterThan(0);
  });

  test('each recorded text publication renders no unrelated message row or committed selector and mutates no unrelated DOM', () => {
    const { attributed, samples, savedId } = measured();
    for (const kind of TEXT_KINDS) {
      expect(samples[kind]).toHaveLength(TRIALS);
      expect(attributed[kind]).toHaveLength(ATTRIBUTION_TRIALS);
      for (const sample of [...attributed[kind], ...samples[kind]]) {
        expect(sample.selectorRenders, kind).toEqual(ZERO_COUNTS);
        // PR #3547's memoized tool part: the tool-part router itself is not re-rendered.
        expect(sample.toolCardRenders, `${kind}: memoized tool-part router renders`).toBe(0);
        expect(sample.unrelatedDom, kind).toEqual([]);
        expect(sample.rendersByOwner[savedId], `${kind}: saved row renders`).toBeUndefined();
        expect(
          sample.rendersByOwner[recordedPromptId],
          `${kind}: prompt row renders`
        ).toBeUndefined();
      }
    }
    // Non-vacuous: the walked token really rendered its own (streaming) message.
    for (const token of attributed['text-delta']) {
      expect(Object.keys(token.rendersByOwner)).toContain(recordedRunId);
    }
  });

  test('a recorded token re-renders no shipped tool card (React DevTools did-render rule)', () => {
    const tokens = measured().attributed['text-delta'];
    expect(tokens).toHaveLength(ATTRIBUTION_TRIALS);
    for (const token of tokens) {
      const answerRenders = token.rendersByOwner[recordedRunId] ?? {};
      expect(
        Object.keys(answerRenders).filter((name) => TOOL_CARD_COMPONENTS.has(name)),
        'tool card components rendered by one token'
      ).toEqual([]);
    }
  });

  test('independent child publications cause zero root-view renders', () => {
    const { child } = measured();
    expect(child).toHaveLength(ATTRIBUTION_TRIALS + TRIALS);
    for (const phase of child) {
      expect(phase.childCommits).toBeGreaterThan(0);
      expect(phase.rootCommits).toBe(0);
      expect(phase.rootSelectorRenders).toEqual(ZERO_COUNTS);
    }
  });

  // BST-1929: the per-token budget is structural. The 8 ms wall-clock gate
  // depended on machine load (quarantined 2026-10-09); token timings are now
  // reported by the advisory perf lane (`pnpm --filter @brainstrike/assistant-ui
  // perf:streaming`), and each publication here is measured until its text has
  // committed rather than after two quiet frames.
  test('a recorded token renders the streaming message in exactly one commit', () => {
    const tokens = measured().attributed['text-delta'];
    expect(tokens).toHaveLength(ATTRIBUTION_TRIALS);
    for (const token of tokens) {
      expect(token.commitsByOwner[recordedRunId], 'streaming message commits').toBe(1);
    }
  });

  test('a recorded token renders no other message row', () => {
    for (const kind of TEXT_KINDS) {
      for (const sample of measured().attributed[kind]) {
        const owners = Object.keys(sample.rendersByOwner);
        expect(
          owners.filter((owner) => owner !== recordedRunId && owner !== 'outside'),
          kind
        ).toEqual([]);
      }
    }
  });
});
