import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import { expect, test } from './fixtures/electron-fixture';
import { type HostThreadLog, readHostThreadTree } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

const TASK = 'EXPLORE_TASK_5A: list what the notes say.';
const LEDGER = 'Background invocations of this turn';
const FOLLOW_UP = 'FOLLOW_UP_5B: anything else in the notes?';
const CONTINUATION = '<child_continuation_result>';
const CALL_SIGN = /^[A-Z][a-z]+-[a-f0-9]{6}$/u;
const CALL_SIGN_CONVERSATION = /^Open [A-Z][a-z]+-[a-f0-9]{6} conversation$/u;

/** A thread's committed runs as a spec reads them: how each was admitted and how it ended. */
function committedRuns(rows: readonly HostLogRow[]) {
  return rows.flatMap(({ event }) => {
    if (event.type !== 'run.started') {
      return [];
    }
    const finished = rows.find(
      (row) => row.event.type === 'run.finished' && row.event.runId === event.runId
    )?.event;
    return [
      {
        delivered: event.delivery?.entries.map((entry) => entry.state) ?? [],
        detail: finished?.type === 'run.finished' ? (finished.detail ?? null) : null,
        outcome: finished?.type === 'run.finished' ? finished.outcome : 'running',
        via: event.delivery?.via ?? 'command',
      },
    ];
  });
}

function committedTree(logs: readonly HostThreadLog[]) {
  return logs.map(({ parentThreadId, rows }) => {
    const started = rows.find((row) => row.event.type === 'thread.started')?.event;
    const origin =
      started?.type === 'thread.started' && 'origin' in started ? started.origin : null;
    return {
      child: parentThreadId !== undefined,
      origin: origin
        ? { background: origin.background, depth: origin.depth, persona: origin.persona }
        : null,
      runs: committedRuns(rows),
    };
  });
}

/**
 * BST-1932 S5: a desktop host thread advertises the user's personas, runs a
 * background Explorer child under its persona's narrowed tools, and wakes the
 * parent once with the child's result. Only the provider is scripted.
 */
test('a host thread delegates to a background persona child, wakes with its result, and drives the child from its tab', async ({
  electron,
  modelProvider,
  window,
}) => {
  const { mockFileSystemOperations } = await loadElectronHelpers();
  await mockFileSystemOperations(window);
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  modelProvider.setScript(({ messages, requestBody, toolNames }) => {
    if ((requestBody as { stream?: unknown }).stream !== true) {
      return { finalText: 'Delegation thread' };
    }
    const history = JSON.stringify(messages);
    if (toolNames.includes('agent-explore')) {
      if (history.includes(CONTINUATION)) {
        return { finalText: 'Parent read the follow-up.' };
      }
      return history.includes(LEDGER)
        ? { finalText: 'Parent read the child.' }
        : {
            finalText: 'Parent continues while Explorer runs.',
            toolCall: { arguments: { prompt: TASK }, name: 'agent-explore' },
          };
    }
    return {
      finalText: history.includes('FOLLOW_UP_5B') ? 'Child follow-up 5B.' : 'Child finding 5A.',
    };
  });
  await ensureAssistantShellVisible(window);
  const input = window.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  await input.fill('Ask Explorer what the notes say');
  await window.getByRole('button', { exact: true, name: 'Send' }).click();

  // The committed host log first: the parent's turn, its one background
  // Explorer child, and exactly one wake that delivered the child's return.
  await expect
    .poll(async () => committedTree(await readHostThreadTree(electron.getUserDataDir())), {
      timeout: E2E_TIMEOUTS.messageVisibility,
    })
    .toEqual([
      {
        child: false,
        origin: null,
        runs: [
          { delivered: [], detail: null, outcome: 'completed', via: 'command' },
          { delivered: ['returned'], detail: null, outcome: 'completed', via: 'wake' },
        ],
      },
      {
        child: true,
        origin: { background: true, depth: 1, persona: 'explore' },
        runs: [{ delivered: [], detail: null, outcome: 'completed', via: 'command' }],
      },
    ]);
  await expect(window.getByText('Parent read the child.').first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  // The wake's ledger is the model's input, never a message the user sent.
  await expect(window.getByText(LEDGER)).toHaveCount(0);

  const streamed = modelProvider
    .requests()
    .filter(({ requestBody }) => (requestBody as { stream?: unknown }).stream === true);
  const parent = streamed[0];
  expect(parent?.toolNames).toEqual(
    expect.arrayContaining(['agent-analyze', 'agent-explore', 'agent-worker'])
  );
  const child = streamed.find(
    ({ messages, toolNames }) =>
      JSON.stringify(messages).includes(TASK) && !toolNames.includes('agent-explore')
  );
  expect(child, 'the Explorer child must reach the provider').toBeDefined();
  // A read-only child never delegates and keeps only its declared read tools.
  expect(child?.toolNames.filter((name) => name.startsWith('agent-'))).toEqual([]);
  expect(JSON.stringify(child?.messages)).toContain('You are the Explorer subagent');
  const acknowledged = streamed.find(
    ({ messages, toolNames }) =>
      toolNames.includes('agent-explore') &&
      JSON.stringify(messages).includes('Background task started.') &&
      !JSON.stringify(messages).includes(LEDGER)
  );
  expect(acknowledged, 'the parent continues after the dispatch acknowledgement').toBeDefined();
  const wakes = streamed.filter(({ messages }) => JSON.stringify(messages).includes(LEDGER));
  expect(wakes).toHaveLength(1);
  expect(JSON.stringify(wakes[0]?.messages)).toContain('Child finding 5A.');

  // The card opens the child's own host thread in a workspace tab.
  const root = window.getByRole('region', { exact: true, name: 'Assistant' });
  await root.getByRole('button', { exact: true, name: 'Expand activity' }).first().click();
  // The child presents its shipped call sign on the card, its tab and its view.
  await root.getByRole('button', { name: CALL_SIGN_CONVERSATION }).click();
  const childTab = window
    .getByRole('tablist', { name: 'Workspace tabs' })
    .getByRole('tab', { selected: true });
  await expect(childTab).toHaveText(CALL_SIGN);
  await expect(childTab).toHaveAttribute('data-agent-color', /^family:\d+:\d+$/u);
  const callSign = (await childTab.innerText()).trim();
  const childView = window.getByRole('region', { exact: true, name: callSign });
  await expect(childView.getByText(TASK, { exact: true })).toBeVisible();
  await expect(childView.getByText('Child finding 5A.', { exact: true })).toBeVisible();

  // Typing into the idle child continues its thread, and the parent wakes once more.
  await childView.getByRole('textbox', { name: 'Message input' }).fill(FOLLOW_UP);
  await childView.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(childView.getByText('Child follow-up 5B.', { exact: true })).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  await expect(root.getByText('Parent read the follow-up.', { exact: true })).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  await expect
    .poll(async () => committedTree(await readHostThreadTree(electron.getUserDataDir())), {
      timeout: E2E_TIMEOUTS.messageVisibility,
    })
    .toEqual([
      {
        child: false,
        origin: null,
        runs: [
          { delivered: [], detail: null, outcome: 'completed', via: 'command' },
          { delivered: ['returned'], detail: null, outcome: 'completed', via: 'wake' },
          { delivered: ['returned'], detail: null, outcome: 'completed', via: 'wake' },
        ],
      },
      {
        child: true,
        origin: { background: true, depth: 1, persona: 'explore' },
        runs: [
          { delivered: [], detail: null, outcome: 'completed', via: 'command' },
          { delivered: [], detail: null, outcome: 'completed', via: 'command' },
        ],
      },
    ]);
  const continued = modelProvider
    .requests()
    .filter(
      ({ messages, toolNames }) =>
        toolNames.includes('agent-explore') && JSON.stringify(messages).includes(CONTINUATION)
    );
  expect(continued).toHaveLength(1);
  expect(JSON.stringify(continued[0]?.messages)).toContain('Child follow-up 5B.');

  // A reload restores the child tab from its address, authorized by the host,
  // and shows its committed conversation without a model call.
  const settledRequests = modelProvider.requests().length;
  await window.reload();
  await ensureAssistantShellVisible(window);
  await expect(
    window.getByRole('tablist', { name: 'Workspace tabs' }).getByRole('tab', { name: callSign })
  ).toBeVisible({ timeout: E2E_TIMEOUTS.messageVisibility });
  await expect(childView.getByText('Child follow-up 5B.', { exact: true })).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  await expect(childView.getByText(TASK, { exact: true })).toBeVisible();
  expect(modelProvider.requests()).toHaveLength(settledRequests);
  expect(modelProvider.refusals()).toEqual([]);
});
