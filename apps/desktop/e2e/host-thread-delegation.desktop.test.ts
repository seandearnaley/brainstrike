import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import { expect, test } from './fixtures/electron-fixture';
import { type HostThreadLog, readHostThreadTree } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

const TASK = 'EXPLORE_TASK_5A: list what the notes say.';
const LEDGER = 'Background invocations of this turn';

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
test('a host thread delegates to a background persona child and wakes with its result', async ({
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
      return history.includes(LEDGER)
        ? { finalText: 'Parent read the child.' }
        : {
            finalText: 'Parent continues while Explorer runs.',
            toolCall: { arguments: { prompt: TASK }, name: 'agent-explore' },
          };
    }
    return { finalText: 'Child finding 5A.' };
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
  expect(modelProvider.refusals()).toEqual([]);
});
