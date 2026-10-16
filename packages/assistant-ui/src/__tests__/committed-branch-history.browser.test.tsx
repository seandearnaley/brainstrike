import '@testing-library/jest-dom/vitest';
// Installs the shared browser instrumentation before React and assistant-ui load.
import './committed-assistant-browser-support';
import { TooltipProvider } from '@brainstrike/ui';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { expect, onTestFinished, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { CommittedAssistantConversation } from '../committed-assistant-conversation';
import type { CommittedAssistantLogRow } from '../committed-assistant-log-projection';
import {
  type CommittedAssistantLogSourceSnapshot,
  CommittedAssistantLogStore,
} from '../committed-assistant-log-store';
import type { CommittedAssistantCommands } from '../committed-assistant-store';
import {
  captureUncaught,
  messageRoots,
  press,
  settleFrames,
} from './committed-assistant-browser-support';
// A real HostCore + SQLite recording of a branched thread (record-branched-log.mjs):
// First, Second, a regenerated Second, and an edited Second, with each run's
// committed identity as committedRunIdentity derived it.
import branches from './fixtures/committed-host-branches.json';
import '@brainstrike/ui/globals.css';
import '../overrides.css';
import './assistant-conversation-panel.browser.css';

/**
 * BST-1929 committed branch history in real Chromium (#3543 6054972701): the
 * shipped conversation over a recorded branched host log. Branch selection is
 * view state only; Regenerate and Edit dispatch the committed identities.
 */

const LABEL = 'Committed conversation';
const rows = branches.rows as readonly CommittedAssistantLogRow[];
const identities: Readonly<
  Record<
    string,
    {
      readonly assistantMessageId: string;
      readonly createdAt: string;
      readonly parentMessageId: string | null;
      readonly userMessageId: string;
    }
  >
> = branches.identities;
const runIds = Object.keys(identities);
const runAt = (index: number): string => {
  const runId = runIds[index];
  if (!runId) {
    throw new Error('The branched recording is missing a run.');
  }
  return runId;
};
const [FIRST, SECOND, REGENERATED, EDITED] = [runAt(0), runAt(1), runAt(2), runAt(3)];
const identity = (runId: string | undefined) => {
  const found = runId === undefined ? undefined : identities[runId];
  if (!found) {
    throw new Error('The branched recording is missing a run identity.');
  }
  return found;
};
const FIRST_USER = identity(FIRST).userMessageId;
const SECOND_USER = identity(SECOND).userMessageId;
const EDITED_USER = identity(EDITED).userMessageId;
if (identity(REGENERATED).userMessageId !== SECOND_USER) {
  throw new Error('The recording no longer regenerates the second user message.');
}

/** Passive: publishes the recorded committed log; it never folds or answers commands. */
class RecordedBranches {
  private readonly snapshot: CommittedAssistantLogSourceSnapshot = {
    connected: true,
    error: undefined,
    rows,
  };
  readonly getSnapshot = (): CommittedAssistantLogSourceSnapshot => this.snapshot;
  readonly subscribe = (): (() => void) => () => undefined;
}

function branchedStore(): CommittedAssistantLogStore {
  const store = new CommittedAssistantLogStore({
    // Test-owned resolver over the recorded committedRunIdentity values.
    identifyRun: (row) => {
      const recorded = identity(String(row.event['runId']));
      return { ...recorded, createdAt: new Date(recorded.createdAt) };
    },
    source: new RecordedBranches(),
    threadId: String(rows[0]?.threadId),
  });
  onTestFinished(() => store.dispose());
  return store;
}

function Surface({
  actions,
  store,
}: {
  readonly actions: CommittedAssistantCommands;
  readonly store: CommittedAssistantLogStore;
}): ReactElement {
  return (
    <TooltipProvider>
      <div style={{ height: 620, width: 900 }}>
        <CommittedAssistantConversation commands={actions} label={LABEL} store={store} />
      </div>
    </TooltipProvider>
  );
}

function surface() {
  const region = screen.getByRole('region', { name: LABEL });
  const ui = within(region);
  const viewport = ui.getByTestId('assistant-ui-viewport');
  const row = (id: string): HTMLElement => {
    const found = messageRoots(viewport).get(id);
    if (!found) {
      throw new Error(`Message ${id} is not on the visible branch.`);
    }
    return found;
  };
  return { path: () => [...messageRoots(viewport).keys()], row, ui };
}

function commands() {
  return {
    onEdit: vi.fn(async () => undefined),
    onNew: vi.fn(async () => undefined),
    onReload: vi.fn(async () => undefined),
    setMessages: vi.fn(),
  } satisfies CommittedAssistantCommands;
}

async function showSecondBranch(view: ReturnType<typeof surface>): Promise<void> {
  await press(within(view.row(EDITED_USER)).getByRole('button', { name: 'Previous branch' }));
  await settleFrames();
}

test('a committed edit and a regeneration are navigable branches, and selecting one writes nothing', async () => {
  const uncaught = captureUncaught();
  const store = branchedStore();
  const actions = commands();
  render(<Surface actions={actions} store={store} />);
  const view = surface();
  // The newest run (the edit) is the committed head. A new message root
  // fades in (its `enter` animation starts at opacity 0), and plain user text
  // renders at once, so visibility is awaited rather than assumed.
  const head = await view.ui.findByText('Add a rollback step with an owner.');
  await waitFor(() => expect(head).toBeVisible());
  expect(view.path()).toEqual([FIRST_USER, FIRST, EDITED_USER, EDITED]);
  const committed = store.getSnapshot().repository;
  expect(within(view.row(EDITED_USER)).getByText('2 / 2')).toBeVisible();

  await showSecondBranch(view);
  // The original answer and its regeneration are siblings under one user message.
  expect(view.path()).toEqual([FIRST_USER, FIRST, SECOND_USER, SECOND]);
  expect(view.ui.getByText('Add a rollback step.')).toBeVisible();
  expect(within(view.row(SECOND)).getByText('1 / 2')).toBeVisible();
  await press(within(view.row(SECOND)).getByRole('button', { name: 'Next branch' }));
  await settleFrames();
  expect(view.path()).toEqual([FIRST_USER, FIRST, SECOND_USER, REGENERATED]);
  expect(within(view.row(REGENERATED)).getByText('2 / 2')).toBeVisible();

  // Selection is the vendor's view state; the committed tree is untouched.
  expect(actions.setMessages).toHaveBeenCalledTimes(2);
  expect(store.getSnapshot().repository).toBe(committed);
  expect(actions.onNew).not.toHaveBeenCalled();
  expect(actions.onEdit).not.toHaveBeenCalled();
  expect(actions.onReload).not.toHaveBeenCalled();
  expect(uncaught).toEqual([]);
});

test('Regenerate and Edit on a selected branch dispatch its committed user message and parent', async () => {
  const store = branchedStore();
  const actions = commands();
  render(<Surface actions={actions} store={store} />);
  const view = surface();
  await view.ui.findByText('Add a rollback step with an owner.');
  await showSecondBranch(view);
  await press(within(view.row(SECOND)).getByRole('button', { name: 'Next branch' }));
  await settleFrames();

  await act(async () => {
    await userEvent.hover(view.row(REGENERATED));
  });
  await press(
    await within(view.row(REGENERATED)).findByRole('button', { name: 'Regenerate response' })
  );
  expect(actions.onReload).toHaveBeenCalledOnce();
  expect(actions.onReload).toHaveBeenCalledWith(SECOND_USER, expect.anything());

  await act(async () => {
    await userEvent.hover(view.row(SECOND_USER));
  });
  await press(await within(view.row(SECOND_USER)).findByRole('button', { name: 'Edit message' }));
  // The edit composer replaces the message row; the main composer is "Message input".
  await settleFrames();
  const editor = view.ui
    .getAllByRole('textbox')
    .find((box) => box.getAttribute('aria-label') !== 'Message input');
  const form = editor?.closest('form');
  if (!(editor && form)) {
    throw new Error('The edit composer did not open.');
  }
  expect(editor).toHaveValue('Add a rollback step.');
  await act(async () => {
    await userEvent.clear(editor);
    await userEvent.type(editor, 'Add a rollback step and a dry run.');
  });
  await press(within(form).getByRole('button', { name: 'Send' }));
  expect(actions.onEdit).toHaveBeenCalledOnce();
  expect(actions.onEdit).toHaveBeenCalledWith(
    expect.objectContaining({
      content: [{ text: 'Add a rollback step and a dry run.', type: 'text' }],
      parentId: FIRST,
      sourceId: SECOND_USER,
    })
  );
  expect(actions.onNew).not.toHaveBeenCalled();
});
